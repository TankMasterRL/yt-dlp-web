/**
 * An animated JPEG XL encoder: RGBA frames in, a looping, lossless JPEG XL
 * codestream out (ISO/IEC 18181-1), written by hand the way libjxl's fastest
 * lossless mode writes it — nothing borrowed but the layout.
 *
 * - Modular mode, 8 bits per channel, sRGB. Each frame's RGB becomes YCoCg
 *   (the reversible colour transform), and every pixel is predicted from its
 *   neighbours with the clamped gradient predictor; the MA tree has one leaf
 *   per channel, so each channel gets its own statistics.
 * - Residuals are written with prefix (Huffman) codes, built per frame and
 *   limited to 15 bits by package-merge; runs of one value (flat areas) are
 *   single LZ77 copies of the value before, which costs one length symbol.
 * - Frames are split into 256×256 groups when larger, as the format asks.
 * - Timing is exact: ticks of 1/fps, and a frame that changes nothing adds its
 *   tick to the one before.
 */

export interface JxlOptions {
	width: number;
	height: number;
	fps: number;
}

/** A U32 distribution: a fixed value, or `bits` raw bits plus `offset`. */
type Dist = { value: number } | { bits: number; offset: number };
const val = (value: number): Dist => ({ value });
const bits = (n: number, offset = 0): Dist => ({ bits: n, offset });

const SIZE: Dist[] = [bits(9, 1), bits(13, 1), bits(18, 1), bits(30, 1)];
const TPS_NUMERATOR: Dist[] = [val(100), val(1000), bits(10, 1), bits(30, 1)];
const TPS_DENOMINATOR: Dist[] = [val(1), val(1001), bits(8, 1), bits(10, 1)];
const NUM_LOOPS: Dist[] = [val(0), bits(3), bits(16), bits(32)];
const BITS_PER_SAMPLE: Dist[] = [val(8), val(10), val(12), bits(6, 1)];
const SMALL_ENUM: Dist[] = [val(0), val(1), val(2), val(3)];
const UPSAMPLING: Dist[] = [val(1), val(2), val(4), val(8)];
const NUM_PASSES: Dist[] = [val(1), val(2), val(3), bits(3, 4)];
const DURATION: Dist[] = [val(0), val(1), bits(8), bits(32)];
const NAME_LENGTH: Dist[] = [val(0), bits(4), bits(5, 16), bits(10, 48)];
const TOC_ENTRY: Dist[] = [bits(10), bits(14, 1024), bits(22, 17408), bits(30, 4211712)];
const NUM_TRANSFORMS: Dist[] = [val(0), val(1), bits(4, 2), bits(8, 18)];
const BEGIN_CHANNEL: Dist[] = [bits(3), bits(6, 8), bits(10, 72), bits(13, 1096)];
const RCT_TYPE: Dist[] = [val(6), bits(2), bits(3, 2), bits(4, 10)];
const NUM_EXTRA_CHANNELS: Dist[] = [val(0), val(1), bits(4, 2), bits(12, 1)];
const LZ77_MIN_SYMBOL_DIST: Dist[] = [val(224), val(512), val(4096), bits(15, 8)];
const LZ77_MIN_LENGTH_DIST: Dist[] = [val(3), val(4), bits(2, 5), bits(8, 9)];

/** Symbols from here up are LZ77 copy lengths (the decoder's lz77 min_symbol). */
const LZ77_MIN_SYMBOL = 224;
const LZ77_MIN_LENGTH = 3;
/** Shorter runs cost about as much copied as written out. */
const MIN_RUN = 8;
/** Special distance 1 is (1, 0): the value decoded just before. */
const DISTANCE_PREVIOUS = 1;

const GROUP_DIM = 256;
const LF_GROUP_DIM = GROUP_DIM * 8;
const GRADIENT = 5;
const RCT = 0;
const YCOCG = 6;
/** The order in which code length code lengths are written (Brotli's). */
const CODE_LENGTH_ORDER = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];
/** The fixed code for code length code lengths 0-5: [bit count, bits]. */
const CODE_LENGTH_CODE: [number, number][] = [
	[2, 0],
	[4, 7],
	[3, 3],
	[2, 2],
	[2, 1],
	[4, 15]
];

class BitWriter {
	#bytes = new Uint8Array(4096);
	#length = 0;
	#pending = 0;
	#pendingBits = 0;

	/** Writes the low `n` bits of `value`, least significant first. */
	write(n: number, value: number): void {
		if (n > 24) {
			this.write(16, value & 0xffff);
			this.write(n - 16, Math.floor(value / 0x10000));
			return;
		}
		this.#pending |= (value & ((1 << n) - 1)) << this.#pendingBits;
		this.#pendingBits += n;
		while (this.#pendingBits >= 8) {
			this.#byte(this.#pending & 0xff);
			this.#pending >>>= 8;
			this.#pendingBits -= 8;
		}
	}

	bool(value: boolean): void {
		this.write(1, value ? 1 : 0);
	}

	u32(value: number, dists: Dist[]): void {
		const selector = dists.findIndex((d) =>
			'value' in d ? d.value === value : value >= d.offset && value - d.offset < 2 ** d.bits
		);
		if (selector < 0) throw new RangeError(`${value} does not fit its field`);
		this.write(2, selector);
		const d = dists[selector];
		if ('bits' in d) this.write(d.bits, value - d.offset);
	}

	/** U64 0: only "no extensions" is ever written. */
	zeroU64(): void {
		this.write(2, 0);
	}

	padToByte(): void {
		if (this.#pendingBits) this.write(8 - this.#pendingBits, 0);
	}

	bytes(): Uint8Array<ArrayBuffer> {
		this.padToByte();
		return this.#bytes.slice(0, this.#length);
	}

	#byte(value: number): void {
		if (this.#length === this.#bytes.length) {
			const grown = new Uint8Array(this.#bytes.length * 2);
			grown.set(this.#bytes);
			this.#bytes = grown;
		}
		this.#bytes[this.#length++] = value;
	}
}

/** Zigzag: 0, -1, 1, -2 … → 0, 1, 2, 3 … */
const packSigned = (v: number) => (v >= 0 ? v * 2 : -v * 2 - 1);

/** The hybrid uint token of `v` under split exponent 0: 0, or 1 + floor(log2 v) and its low bits. */
function token(v: number): number {
	return v === 0 ? 0 : 32 - Math.clz32(v);
}

/**
 * Optimal prefix code lengths of at most `limit` bits for `counts`
 * (package-merge). Unused symbols get 0; a lone symbol gets 0 too — it needs
 * no bits at all.
 */
export function codeLengths(counts: number[], limit: number): number[] {
	const used = counts.flatMap((count, symbol) => (count ? [symbol] : []));
	const lengths = counts.map(() => 0);
	if (used.length < 2) return lengths;
	type Item = { weight: number; symbols: number[] };
	const leaves: Item[] = used
		.map((symbol) => ({ weight: counts[symbol], symbols: [symbol] }))
		.sort((a, b) => a.weight - b.weight);
	let row = leaves;
	for (let level = 1; level < limit; level++) {
		const packages: Item[] = [];
		for (let i = 0; i + 1 < row.length; i += 2) {
			packages.push({
				weight: row[i].weight + row[i + 1].weight,
				symbols: [...row[i].symbols, ...row[i + 1].symbols]
			});
		}
		row = [...leaves, ...packages].sort((a, b) => a.weight - b.weight);
	}
	for (const item of row.slice(0, 2 * used.length - 2)) {
		for (const symbol of item.symbols) lengths[symbol]++;
	}
	return lengths;
}

/** Canonical codes for `lengths`, bit-reversed for a least-significant-first stream. */
function canonicalCodes(lengths: number[]): number[] {
	const codes = lengths.map(() => 0);
	const order = lengths
		.map((length, symbol) => ({ length, symbol }))
		.filter((s) => s.length)
		.sort((a, b) => a.length - b.length || a.symbol - b.symbol);
	let code = 0;
	let length = order[0]?.length ?? 0;
	for (const s of order) {
		code <<= s.length - length;
		length = s.length;
		let reversed = 0;
		for (let i = 0; i < length; i++) reversed |= ((code >> i) & 1) << (length - 1 - i);
		codes[s.symbol] = reversed;
		code++;
	}
	return codes;
}

/** One histogram's prefix code. */
class PrefixCode {
	readonly lengths: number[];
	readonly codes: number[];
	/** Symbols 0 … alphabetSize - 1 are representable. */
	readonly alphabetSize: number;

	constructor(counts: number[]) {
		const last = counts.findLastIndex((c) => c > 0);
		this.alphabetSize = Math.max(1, last + 1);
		this.lengths = codeLengths(counts.slice(0, this.alphabetSize), 15);
		this.codes = canonicalCodes(this.lengths);
	}

	symbol(w: BitWriter, symbol: number): void {
		w.write(this.lengths[symbol], this.codes[symbol]);
	}

	/** Writes the code itself, unless its alphabet is a lone symbol 0 (nothing to write). */
	write(w: BitWriter): void {
		if (this.alphabetSize === 1) return;
		const used = this.lengths.flatMap((length, symbol) => (length ? [symbol] : []));
		if (used.length === 0) {
			// One symbol, not 0: a "simple" code of it alone.
			const symbol = this.alphabetSize - 1;
			w.write(2, 1);
			w.write(2, 0);
			w.write(32 - Math.clz32(this.alphabetSize - 1), symbol);
			return;
		}
		w.write(2, 0); // a complex code, skipping no code length code lengths
		const clCounts = Array<number>(18).fill(0);
		for (const length of this.lengths) clCounts[length]++;
		const clUsed = clCounts.filter(Boolean).length;
		let clLengths = codeLengths(clCounts, 5);
		if (clUsed === 1) {
			// Every symbol has the same length: that length is read with no bits at all.
			clLengths = clCounts.map((c) => (c ? 1 : 0));
		}
		const lastOrdered =
			clUsed === 1 ? 17 : CODE_LENGTH_ORDER.findLastIndex((s) => clLengths[s] > 0);
		for (let i = 0; i <= lastOrdered; i++) {
			const [n, value] = CODE_LENGTH_CODE[clLengths[CODE_LENGTH_ORDER[i]]];
			w.write(n, value);
		}
		const clCodes = canonicalCodes(clLengths);
		const writeLength = (length: number) =>
			clUsed === 1 ? undefined : w.write(clLengths[length], clCodes[length]);
		for (const length of this.lengths) writeLength(length);
	}
}

/**
 * Writes the entropy code of a stream: a context map from `contexts`
 * (context → cluster), prefix codes, and hybrid uint configs that split at 0
 * (every token is 1 + floor(log2 value)). With `lz77`, symbols from
 * LZ77_MIN_SYMBOL up are copy lengths, and the last context is the distances'.
 */
function writeEntropyCode(
	w: BitWriter,
	contexts: number[],
	codes: PrefixCode[],
	lz77: boolean
): void {
	w.bool(lz77);
	if (lz77) {
		w.u32(LZ77_MIN_SYMBOL, LZ77_MIN_SYMBOL_DIST);
		w.u32(LZ77_MIN_LENGTH, LZ77_MIN_LENGTH_DIST);
		w.write(4, 0); // copy lengths: split exponent 0 too
	}
	if (contexts.length > 1) {
		w.bool(true); // a simple context map
		const entryBits = Math.ceil(Math.log2(codes.length));
		w.write(2, entryBits);
		for (const cluster of contexts) w.write(entryBits, cluster);
	}
	w.bool(true); // prefix codes
	for (let i = 0; i < codes.length; i++) w.write(4, 0); // split exponent 0, no msb/lsb bits
	for (const code of codes) {
		const size = code.alphabetSize - 1;
		if (size === 0) {
			w.bool(false);
		} else {
			w.bool(true);
			const n = 31 - Math.clz32(size);
			w.write(4, n);
			w.write(n, size - (1 << n));
		}
	}
	for (const code of codes) code.write(w);
}

interface TreeNode {
	/** A decision on the channel index: `channel > split` goes left. */
	split?: number;
	left?: TreeNode;
	right?: TreeNode;
	/** A leaf: this channel's context. */
	channel?: number;
}

/** channel > 0 ? (channel > 1 ? 2 : 1) : 0 — one leaf per channel. */
const TREE: TreeNode = {
	split: 0,
	left: { split: 1, left: { channel: 2 }, right: { channel: 1 } },
	right: { channel: 0 }
};

/** The tree's tokens in decoding order (breadth first) and each channel's leaf (context). */
function serializeTree(tree: TreeNode): { tokens: number[]; leafOf: number[] } {
	const tokens: number[] = [];
	const leafOf: number[] = [];
	const queue = [tree];
	let leaves = 0;
	while (queue.length) {
		const node = queue.shift()!;
		if (node.channel !== undefined) {
			// property 0 means leaf; then predictor, offset, multiplier log, multiplier bits.
			tokens.push(0, GRADIENT, packSigned(0), 0, 0);
			leafOf[node.channel] = leaves++;
		} else {
			// property + 1 (property 0 is the channel index), then the split value.
			tokens.push(1, packSigned(node.split!));
			queue.push(node.left!, node.right!);
		}
	}
	return { tokens, leafOf };
}

const { tokens: TREE_TOKENS, leafOf: LEAF_OF_CHANNEL } = serializeTree(TREE);
/** The data stream's clusters: one per leaf, then the LZ77 distances'. */
const DISTANCE_CLUSTER = LEAF_OF_CHANNEL.length;

/** A rectangle of the frame as the symbols that encode it, in writing order. */
interface Group {
	clusters: Uint8Array;
	symbols: Uint8Array;
	extras: Uint32Array;
	extraBits: Uint8Array;
	length: number;
}

/** Reversible YCoCg: R, G, B → Y, Co, Cg. */
function toYCoCg(rgba: ArrayLike<number>, pixels: number): Int32Array[] {
	const [Y, Co, Cg] = [new Int32Array(pixels), new Int32Array(pixels), new Int32Array(pixels)];
	for (let p = 0, i = 0; p < pixels; p++, i += 4) {
		const co = rgba[i] - rgba[i + 2];
		const tmp = rgba[i + 2] + (co >> 1);
		const cg = rgba[i + 1] - tmp;
		Y[p] = tmp + (cg >> 1);
		Co[p] = co;
		Cg[p] = cg;
	}
	return [Y, Co, Cg];
}

/**
 * Predicts every pixel of a rectangle (an image of its own: no neighbours
 * outside it) and turns the residuals into symbols, channel after channel. A
 * run of the value just before (in flat areas, a run of zeros) becomes one
 * LZ77 copy from distance 1; everything else is a literal in its channel's
 * context. Symbol counts go to `counts`, per cluster.
 */
function tokenize(
	channels: Int32Array[],
	stride: number,
	x0: number,
	y0: number,
	width: number,
	height: number,
	counts: number[][]
): Group {
	const n = width * height * channels.length;
	const values = new Uint32Array(n);
	const contexts = new Uint8Array(n);
	let i = 0;
	for (const [c, plane] of channels.entries()) {
		const context = LEAF_OF_CHANNEL[c];
		for (let y = 0; y < height; y++) {
			const row = (y0 + y) * stride + x0;
			const up = row - stride;
			for (let x = 0; x < width; x++) {
				const left = x ? plane[row + x - 1] : y ? plane[up + x] : 0;
				const top = y ? plane[up + x] : left;
				const topLeft = x && y ? plane[up + x - 1] : left;
				const low = Math.min(left, top);
				const high = Math.max(left, top);
				const guess = Math.min(Math.max(left + top - topLeft, low), high);
				values[i] = packSigned(plane[row + x] - guess);
				contexts[i++] = context;
			}
		}
	}

	const group: Group = {
		clusters: new Uint8Array(n),
		symbols: new Uint8Array(n),
		extras: new Uint32Array(n),
		extraBits: new Uint8Array(n),
		length: 0
	};
	const emit = (cluster: number, symbol: number, value: number) => {
		const k = group.length++;
		group.clusters[k] = cluster;
		group.symbols[k] = symbol;
		// Hybrid uint, split exponent 0: the token's bits below its leading one.
		const tok = symbol >= LZ77_MIN_SYMBOL ? symbol - LZ77_MIN_SYMBOL : symbol;
		group.extraBits[k] = tok > 1 ? tok - 1 : 0;
		group.extras[k] = tok > 1 ? value - (1 << (tok - 1)) : 0;
		counts[cluster][symbol]++;
	};
	for (let at = 0; at < n;) {
		let run = 0;
		if (at > 0) while (at + run < n && values[at + run] === values[at - 1]) run++;
		if (run >= MIN_RUN) {
			const length = run - LZ77_MIN_LENGTH;
			emit(contexts[at], LZ77_MIN_SYMBOL + token(length), length);
			emit(DISTANCE_CLUSTER, token(DISTANCE_PREVIOUS), DISTANCE_PREVIOUS);
			at += run;
		} else {
			emit(contexts[at], token(values[at]), values[at]);
			at++;
		}
	}
	return group;
}

function writeGroup(w: BitWriter, group: Group, codes: PrefixCode[]): void {
	for (let k = 0; k < group.length; k++) {
		codes[group.clusters[k]].symbol(w, group.symbols[k]);
		if (group.extraBits[k]) w.write(group.extraBits[k], group.extras[k]);
	}
}

/** The modular group header: global tree, default weighted predictor, and the transforms. */
function writeGroupHeader(w: BitWriter, withRct: boolean): void {
	w.bool(true); // use the global tree
	w.bool(true); // weighted predictor: all default
	if (!withRct) {
		w.u32(0, NUM_TRANSFORMS);
		return;
	}
	w.u32(1, NUM_TRANSFORMS);
	w.u32(RCT, SMALL_ENUM);
	w.u32(0, BEGIN_CHANNEL);
	w.u32(YCOCG, RCT_TYPE);
}

/** One frame's sections, in TOC order. */
function encodeSections(rgba: ArrayLike<number>, width: number, height: number): Uint8Array[] {
	const channels = toYCoCg(rgba, width * height);
	const groupsX = Math.ceil(width / GROUP_DIM);
	const groupsY = Math.ceil(height / GROUP_DIM);
	const single = groupsX * groupsY === 1;
	// One cluster per channel's leaf, and one for LZ77 distances.
	const counts = Array.from({ length: DISTANCE_CLUSTER + 1 }, () => Array<number>(256).fill(0));
	const groups: Group[] = [];
	for (let gy = 0; gy < groupsY; gy++) {
		for (let gx = 0; gx < groupsX; gx++) {
			const x0 = gx * GROUP_DIM;
			const y0 = gy * GROUP_DIM;
			groups.push(
				tokenize(
					channels,
					width,
					x0,
					y0,
					Math.min(GROUP_DIM, width - x0),
					Math.min(GROUP_DIM, height - y0),
					counts
				)
			);
		}
	}
	const codes = counts.map((c) => new PrefixCode(c));
	const treeCounts = Array<number>(34).fill(0);
	for (const t of TREE_TOKENS) treeCounts[token(t)]++;
	const treeCode = new PrefixCode(treeCounts);

	const global = new BitWriter();
	global.bool(true); // LF channel dequantization: all default
	global.bool(true); // a global MA tree
	writeEntropyCode(global, [0, 0, 0, 0, 0, 0], [treeCode], false);
	for (const t of TREE_TOKENS) {
		const tok = token(t);
		treeCode.symbol(global, tok);
		if (tok > 1) global.write(tok - 1, t - (1 << (tok - 1)));
	}
	// Contexts are the tree's leaves, each its own cluster, then the distances'.
	writeEntropyCode(
		global,
		codes.map((_, i) => i),
		codes,
		true
	);
	writeGroupHeader(global, true);
	if (single) {
		// The whole frame fits one group: its channels are in the global section.
		writeGroup(global, groups[0], codes);
		return [global.bytes()];
	}
	const lfGroups = Math.ceil(width / LF_GROUP_DIM) * Math.ceil(height / LF_GROUP_DIM);
	const sections: Uint8Array[] = [global.bytes()];
	// LF groups and the global HF section hold nothing in a modular frame without squeeze.
	for (let i = 0; i < lfGroups + 1; i++) sections.push(new Uint8Array());
	for (const group of groups) {
		const w = new BitWriter();
		writeGroupHeader(w, false);
		writeGroup(w, group, codes);
		sections.push(w.bytes());
	}
	return sections;
}

interface PendingFrame {
	sections: Uint8Array[];
	/** In ticks of 1/fps. */
	duration: number;
}

export class JxlEncoder {
	readonly #width: number;
	readonly #height: number;
	readonly #chunks: Uint8Array<ArrayBuffer>[] = [];
	#previous: Uint8ClampedArray | null = null;
	#pending: PendingFrame | null = null;
	#finished = false;

	constructor({ width, height, fps }: JxlOptions) {
		this.#width = width;
		this.#height = height;
		const w = new BitWriter();
		w.write(8, 0xff);
		w.write(8, 0x0a);
		// SizeHeader: not "small", no aspect ratio shortcut.
		w.bool(false);
		w.u32(height, SIZE);
		w.write(3, 0);
		w.u32(width, SIZE);
		// ImageMetadata.
		w.bool(false); // not all default
		w.bool(true); // extra fields: orientation, animation …
		w.write(3, 0); // orientation: as stored
		w.bool(false); // no intrinsic size
		w.bool(false); // no preview
		w.bool(true); // an animation
		w.u32(fps, TPS_NUMERATOR); // ticks per second
		w.u32(1, TPS_DENOMINATOR);
		w.u32(0, NUM_LOOPS); // forever
		w.bool(false); // no timecodes
		w.bool(false); // integer samples …
		w.u32(8, BITS_PER_SAMPLE); // … of 8 bits
		w.bool(true); // 16-bit buffers are enough
		w.u32(0, NUM_EXTRA_CHANNELS); // no alpha
		w.bool(false); // not XYB: lossless
		w.bool(true); // colour encoding: all default (sRGB)
		w.bool(true); // tone mapping: all default
		w.zeroU64(); // no extensions
		w.bool(true); // custom transform data: all default
		this.#chunks.push(w.bytes());
	}

	/** Adds a width × height frame of RGBA pixels (alpha ignored), shown for 1/fps s. */
	addFrame(rgba: ArrayLike<number>): void {
		if (this.#finished) throw new Error('the JPEG XL image is finished');
		const [width, height] = [this.#width, this.#height];
		if (rgba.length !== width * height * 4) {
			throw new RangeError(
				`expected a ${width} × ${height} frame (${width * height * 4} bytes), got ${rgba.length} bytes`
			);
		}
		const previous = this.#previous;
		if (previous && this.#pending && previous.every((v, i) => v === rgba[i] || i % 4 === 3)) {
			this.#pending.duration++;
			return;
		}
		this.#previous = Uint8ClampedArray.from(rgba);
		this.#flush(false);
		this.#pending = { sections: encodeSections(rgba, width, height), duration: 1 };
	}

	/** The codestream's bytes, in order. The encoder takes no frames after this. */
	finish(): Uint8Array<ArrayBuffer>[] {
		if (this.#finished) throw new Error('the JPEG XL image is finished');
		if (!this.#pending) throw new Error('a JPEG XL image needs a frame');
		this.#finished = true;
		this.#flush(true);
		return this.#chunks;
	}

	/** Writes the frame held back, now that its duration and whether it is last are known. */
	#flush(last: boolean): void {
		const frame = this.#pending;
		if (!frame) return;
		this.#pending = null;
		const w = new BitWriter();
		w.bool(false); // not all default
		w.u32(0, SMALL_ENUM); // a regular frame
		w.bool(true); // modular
		w.zeroU64(); // no flags (patches, splines, noise …)
		w.bool(false); // no YCbCr
		w.u32(1, UPSAMPLING);
		w.write(2, 1); // groups of 256×256
		w.u32(1, NUM_PASSES);
		w.bool(false); // the whole canvas
		w.u32(0, SMALL_ENUM); // blending: replace
		w.u32(frame.duration, DURATION);
		w.bool(last);
		if (!last) w.u32(0, SMALL_ENUM); // not kept as a reference
		w.u32(0, NAME_LENGTH);
		w.bool(false); // loop filter: not all default …
		w.bool(false); // … no Gaborish
		w.write(2, 0); // … no edge-preserving filter
		w.zeroU64(); // … no extensions
		w.zeroU64(); // no frame header extensions
		// The table of contents: section sizes, in order.
		w.bool(false); // not permuted
		w.padToByte();
		for (const section of frame.sections) w.u32(section.length, TOC_ENTRY);
		this.#chunks.push(w.bytes(), ...(frame.sections as Uint8Array<ArrayBuffer>[]));
	}
}
