/**
 * What an animated image file says of itself — its format, its size, how many
 * frames it shows and for how long — read from its headers and chunk tables,
 * never decoded. For files opened from the device, to show beside them.
 *
 * GIF, PNG (APNG), WebP, AVIF and JPEG XL: the formats the app makes. Each is
 * walked as far as browsers would show it (a GIF cut short still shows its
 * whole frames), and nothing is guessed: what cannot be read is null.
 */
import type { AnimationFormat } from './formats';

export interface ImageInfo {
	/** The format; any PNG is 'apng', animated or not. */
	format: AnimationFormat;
	/** Whether it plays: more than one frame, or an animation of frames not counted. */
	animated: boolean;
	/** As shown: after any rotation the file asks for. */
	width: number;
	height: number;
	/** The frames shown; null where the file could not be read through. */
	frames: number | null;
	/** Seconds one play lasts; null for a still, or where unknown. */
	duration: number | null;
}

/** How many of a file's first bytes say its format (an AVIF's ftyp box can list many brands). */
export const SIGNATURE_BYTES = 4096;

/** The format a file's first bytes say it is in, or null for none of the five. */
export function imageFormat(bytes: Uint8Array): AnimationFormat | null {
	const tag = ascii(bytes, 0, 6);
	if (tag === 'GIF87a' || tag === 'GIF89a') return 'gif';
	if (startsWith(bytes, PNG_SIGNATURE)) return 'apng';
	if (ascii(bytes, 0) === 'RIFF' && ascii(bytes, 8) === 'WEBP') return 'webp';
	if (startsWith(bytes, JXL_SIGNATURE) || startsWith(bytes, JXL_CONTAINER)) return 'jxl';
	const [ftyp] = boxes(bytes, 0, Math.min(bytes.length, SIGNATURE_BYTES));
	if (ftyp?.type !== 'ftyp') return null;
	// The major brand, then the compatible ones after the minor version.
	const brands = [ascii(bytes, ftyp.start)];
	for (let at = ftyp.start + 8; at + 4 <= ftyp.end; at += 4) brands.push(ascii(bytes, at));
	return brands.includes('avif') || brands.includes('avis') ? 'avif' : null;
}

const READERS: Record<AnimationFormat, (bytes: Uint8Array) => ImageInfo | null> = {
	gif: readGif,
	apng: readPng,
	webp: readWebp,
	avif: readAvif,
	jxl: readJxl
};

/** The image's details, or null if it is none of the five formats, or its header is unreadable. */
export function readImage(bytes: Uint8Array): ImageInfo | null {
	const format = imageFormat(bytes);
	return format && READERS[format](bytes);
}

function info(
	format: AnimationFormat,
	width: number,
	height: number,
	frames: number | null,
	duration: number | null,
	declaredAnimation = false
): ImageInfo | null {
	if (!(width > 0 && height > 0)) return null;
	const animated = frames === null ? declaredAnimation : frames > 1;
	return {
		format,
		animated,
		width,
		height,
		frames,
		duration: animated && frames !== null ? duration : null
	};
}

const ascii = (b: Uint8Array, at: number, n = 4) => String.fromCharCode(...b.subarray(at, at + n));
const startsWith = (b: Uint8Array, signature: number[]) => signature.every((v, i) => b[i] === v);
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/**
 * GIF: every image descriptor whose data is all there is a frame, each shown for
 * the delay of the graphic control extension just before it. Browsers show a
 * delay under 2 cs (or none) as 10 cs, and so is it counted. Reading stops at
 * the trailer, the end of the file, or anything else, as browsers' decoders do.
 */
function readGif(b: Uint8Array): ImageInfo | null {
	if (b.length < 13) return null;
	const v = view(b);
	const [width, height] = [v.getUint16(6, true), v.getUint16(8, true)];
	const table = (packed: number) => (packed & 0x80 ? 3 << ((packed & 7) + 1) : 0);
	/** Past the sub-blocks starting at `at`, or -1 where the file ends first. */
	const skipSubBlocks = (at: number) => {
		while (at < b.length) {
			const size = b[at];
			at += 1 + size;
			if (size === 0) return at;
		}
		return -1;
	};
	let at = 13 + table(b[10]);
	let frames = 0;
	let centiseconds = 0;
	let delay = 0;
	while (at < b.length) {
		const block = b[at];
		if (block === 0x21) {
			if (b[at + 1] === 0xf9 && b[at + 2] >= 4 && at + 6 < b.length) {
				delay = v.getUint16(at + 4, true);
			}
			at = skipSubBlocks(at + 2);
		} else if (block === 0x2c) {
			if (at + 11 > b.length) break;
			// The descriptor, a local color table, the LZW code size, then the data.
			at = skipSubBlocks(at + 10 + table(b[at + 9]) + 1);
			if (at < 0) break;
			frames++;
			centiseconds += delay < 2 ? 10 : delay;
			// A graphic control extension governs the one image after it.
			delay = 0;
		} else {
			// The trailer (0x3b), or what no decoder reads past.
			break;
		}
		if (at < 0) break;
	}
	return info('gif', width, height, frames || null, centiseconds / 100);
}

/**
 * PNG: an APNG when an acTL chunk comes before the image data; its frames are
 * its fcTL chunks, each delay_num / delay_den s (a denominator of 0 is 100).
 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readPng(b: Uint8Array): ImageInfo | null {
	const v = view(b);
	let width = 0;
	let height = 0;
	let animation = false;
	let seenData = false;
	let frames = 0;
	let seconds = 0;
	for (let at = 8; at + 8 <= b.length;) {
		const length = v.getUint32(at);
		const type = ascii(b, at + 4);
		const data = at + 8;
		if (data + length > b.length) break;
		if (type === 'IHDR' && length >= 8) {
			width = v.getUint32(data);
			height = v.getUint32(data + 4);
		} else if (type === 'acTL' && !seenData) {
			animation = true;
		} else if (type === 'fcTL' && length >= 26) {
			frames++;
			const [num, den] = [v.getUint16(data + 20), v.getUint16(data + 22)];
			seconds += num / (den || 100);
		} else if (type === 'IDAT') {
			seenData = true;
		} else if (type === 'IEND') {
			break;
		}
		at = data + length + 4;
	}
	if (!animation || frames === 0) return info('apng', width, height, 1, null);
	return info('apng', width, height, frames, seconds);
}

/**
 * WebP: the canvas and its animation flag from VP8X, every ANMF chunk a frame
 * of its own duration (ms); a simple file's size from its one VP8 or VP8L image.
 */
function readWebp(b: Uint8Array): ImageInfo | null {
	const v = view(b);
	const u24 = (at: number) => v.getUint16(at, true) | (b[at + 2] << 16);
	const first = 12;
	if (first + 8 > b.length) return null;
	const type = ascii(b, first);
	const data = first + 8;
	if (type === 'VP8 ') {
		if (data + 10 > b.length || !startsWith(b.subarray(data + 3), [0x9d, 0x01, 0x2a])) return null;
		return info(
			'webp',
			v.getUint16(data + 6, true) & 0x3fff,
			v.getUint16(data + 8, true) & 0x3fff,
			1,
			null
		);
	}
	if (type === 'VP8L') {
		if (data + 5 > b.length || b[data] !== 0x2f) return null;
		const bits = v.getUint32(data + 1, true);
		return info('webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, 1, null);
	}
	if (type !== 'VP8X' || data + 10 > b.length) return null;
	const [width, height] = [u24(data + 4) + 1, u24(data + 7) + 1];
	if (!(b[data] & 0x02)) return info('webp', width, height, 1, null);
	let frames = 0;
	let milliseconds = 0;
	for (let at = first; at + 8 <= b.length;) {
		const size = v.getUint32(at + 4, true);
		if (at + 8 + size > b.length) break;
		if (ascii(b, at) === 'ANMF' && size >= 16) {
			frames++;
			milliseconds += u24(at + 8 + 12);
		}
		at += 8 + size + (size % 2);
	}
	return info('webp', width, height, frames || null, milliseconds / 1000, true);
}

interface Box {
	type: string;
	/** Where its payload starts and ends. */
	start: number;
	end: number;
}

/** The boxes in b[start, end): a box that runs past the end ends the list. */
function boxes(b: Uint8Array, start: number, end: number): Box[] {
	const v = view(b);
	const out: Box[] = [];
	for (let at = start; at + 8 <= end;) {
		let size = v.getUint32(at);
		let header = 8;
		if (size === 1) {
			if (at + 16 > end) break;
			size = v.getUint32(at + 8) * 2 ** 32 + v.getUint32(at + 12);
			header = 16;
		} else if (size === 0) {
			size = end - at;
		}
		if (size < header || at + size > end) break;
		out.push({ type: ascii(b, at + 4), start: at + header, end: at + size });
		at += size;
	}
	return out;
}

/** The first box of each type along `path`, from within `parent`. */
function find(b: Uint8Array, parent: Box, ...path: string[]): Box | undefined {
	let box = parent;
	for (const type of path) {
		// A meta box is a full box: its children start after version and flags.
		const start: number = box.type === 'meta' ? box.start + 4 : box.start;
		const child = boxes(b, start, box.end).find((c) => c.type === type);
		if (!child) return undefined;
		box = child;
	}
	return box;
}

/**
 * AVIF: its size from the primary item's ispe (cropped by clap, turned by irot);
 * an image sequence's frames and their timing from its picture track's stts.
 */
function readAvif(b: Uint8Array): ImageInfo | null {
	const file: Box = { type: '', start: 0, end: b.length };
	const size = primaryItemSize(b, find(b, file, 'meta'));
	const moov = find(b, file, 'moov');
	const track = moov
		? boxes(b, moov.start, moov.end).find((t) => t.type === 'trak' && handler(b, t) === 'pict')
		: undefined;
	if (!track) return size && info('avif', size.width, size.height, 1, null);
	const shown = size ?? trackSize(b, track);
	if (!shown) return null;
	const timing = trackTiming(b, track);
	return info(
		'avif',
		shown.width,
		shown.height,
		timing?.frames ?? null,
		timing?.seconds ?? null,
		true
	);
}

/** A track's handler type: 'pict' for an image sequence. */
function handler(b: Uint8Array, trak: Box): string | undefined {
	const hdlr = find(b, trak, 'mdia', 'hdlr');
	return hdlr && hdlr.start + 12 <= hdlr.end ? ascii(b, hdlr.start + 8) : undefined;
}

/** A track's own size: tkhd ends with its width and height, in 16.16 fixed point. */
function trackSize(b: Uint8Array, trak: Box): { width: number; height: number } | null {
	const tkhd = find(b, trak, 'tkhd');
	if (!tkhd || tkhd.end - tkhd.start < 84) return null;
	const v = view(b);
	return { width: v.getUint32(tkhd.end - 8) >>> 16, height: v.getUint32(tkhd.end - 4) >>> 16 };
}

/** A track's samples and how long they last, from its timescale and time-to-sample table. */
function trackTiming(b: Uint8Array, trak: Box): { frames: number; seconds: number } | null {
	const mdhd = find(b, trak, 'mdia', 'mdhd');
	const stts = find(b, trak, 'mdia', 'minf', 'stbl', 'stts');
	if (!mdhd || !stts || mdhd.start + 24 > mdhd.end || stts.start + 8 > stts.end) return null;
	const v = view(b);
	const timescale = v.getUint32(mdhd.start + (b[mdhd.start] === 1 ? 20 : 12));
	const entries = v.getUint32(stts.start + 4);
	if (!timescale || stts.start + 8 + entries * 8 > stts.end) return null;
	let [frames, ticks] = [0, 0];
	for (let i = 0, at = stts.start + 8; i < entries; i++, at += 8) {
		frames += v.getUint32(at);
		ticks += v.getUint32(at) * v.getUint32(at + 4);
	}
	return { frames, seconds: ticks / timescale };
}

/** The primary item's size as shown, from the properties associated with it. */
function primaryItemSize(
	b: Uint8Array,
	meta: Box | undefined
): { width: number; height: number } | null {
	if (!meta) return null;
	const v = view(b);
	const pitm = find(b, meta, 'pitm');
	const ipco = find(b, meta, 'iprp', 'ipco');
	const ipma = find(b, meta, 'iprp', 'ipma');
	if (!pitm || !ipco || !ipma) return null;
	const primary = b[pitm.start] === 0 ? v.getUint16(pitm.start + 4) : v.getUint32(pitm.start + 4);
	const properties = boxes(b, ipco.start, ipco.end);
	// ipma: per item, the 1-based indices of its properties, in the order they apply.
	const [version, flags] = [b[ipma.start], b[ipma.start + 3]];
	const indices: number[] = [];
	let at = ipma.start + 8;
	for (let i = 0, n = v.getUint32(ipma.start + 4); i < n && at < ipma.end; i++) {
		const item = version < 1 ? v.getUint16(at) : v.getUint32(at);
		at += version < 1 ? 2 : 4;
		const count = b[at++];
		for (let j = 0; j < count; j++) {
			const index = flags & 1 ? v.getUint16(at) & 0x7fff : b[at] & 0x7f;
			at += flags & 1 ? 2 : 1;
			if (item === primary) indices.push(index);
		}
	}
	let size: { width: number; height: number } | null = null;
	for (const index of indices) {
		const p = properties[index - 1];
		if (!p) continue;
		if (p.type === 'ispe' && p.start + 12 <= p.end) {
			size = { width: v.getUint32(p.start + 4), height: v.getUint32(p.start + 8) };
		} else if (p.type === 'clap' && size && p.start + 16 <= p.end) {
			const ratio = (at: number) => v.getUint32(at) / (v.getUint32(at + 4) || 1);
			size = { width: Math.round(ratio(p.start)), height: Math.round(ratio(p.start + 8)) };
		} else if (p.type === 'irot' && size && p.start < p.end && b[p.start] & 1) {
			size = { width: size.height, height: size.width };
		}
	}
	return size;
}

/** Thrown where a bit reader runs out of bytes, or meets what this reader does not follow. */
class Unreadable extends Error {}

/** Reads a JPEG XL codestream's bits, least significant first. */
class Bits {
	#at = 0;
	constructor(readonly bytes: Uint8Array) {}

	get position(): number {
		return this.#at;
	}

	set position(bit: number) {
		this.#at = bit;
	}

	read(n: number): number {
		let value = 0;
		for (let i = 0; i < n; i++, this.#at++) {
			const byte = this.bytes[this.#at >> 3];
			if (byte === undefined) throw new Unreadable('the codestream ends here');
			value += ((byte >> (this.#at & 7)) & 1) * 2 ** i;
		}
		return value;
	}

	bool(): boolean {
		return this.read(1) === 1;
	}

	/** A U32 of four distributions: a number is that value, [offset, bits] that many bits plus offset. */
	u32(...dists: (number | [number, number])[]): number {
		const d = dists[this.read(2)];
		return typeof d === 'number' ? d : d[0] + this.read(d[1]);
	}

	u64(): number {
		const selector = this.read(2);
		if (selector === 0) return 0;
		if (selector === 1) return 1 + this.read(4);
		if (selector === 2) return 17 + this.read(8);
		let value = this.read(12);
		for (let shift = 12; this.bool(); shift += 8) {
			if (shift === 60) {
				value += this.read(4) * 2 ** 60;
				break;
			}
			value += this.read(8) * 2 ** shift;
		}
		if (value > Number.MAX_SAFE_INTEGER) throw new Unreadable('a number past what this reads');
		return value;
	}

	enum(): number {
		return this.u32(0, 1, [2, 4], [18, 6]);
	}

	skip(n: number): void {
		this.#at += n;
		if (this.#at > this.bytes.length * 8) throw new Unreadable('the codestream ends here');
	}

	zeroPadToByte(): void {
		this.skip((8 - (this.#at & 7)) & 7);
	}

	/** An extensions bundle: which are there, then each one's bits, skipped. */
	extensions(): void {
		let mask = this.u64();
		const lengths: number[] = [];
		for (let i = 0; mask > 0; i++, mask = Math.floor(mask / 2))
			if (mask % 2) lengths.push(this.u64());
		for (const n of lengths) this.skip(n);
	}

	name(): void {
		this.skip(8 * this.u32(0, [0, 4], [16, 5], [48, 10]));
	}

	f16s(n: number): void {
		this.skip(16 * n);
	}
}

const JXL_SIGNATURE = [0xff, 0x0a];
const JXL_CONTAINER = [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a];

/**
 * JPEG XL, a bare codestream or one in the container: its size from the
 * SizeHeader (as oriented), its animation from the image metadata, and its
 * frames by walking each frame header and table of contents to the end. A
 * walk that does not end exactly at the codestream's last byte has misread
 * something, so it counts nothing; so do an ICC profile, a preview and a
 * permuted table of contents, which are entropy coded or rare.
 */
function readJxl(b: Uint8Array): ImageInfo | null {
	let codestream = b;
	if (startsWith(b, JXL_CONTAINER)) {
		const parts: Uint8Array[] = [];
		for (const box of boxes(b, 0, b.length)) {
			if (box.type === 'jxlc') parts.push(b.subarray(box.start, box.end));
			// Partial codestreams carry a 4-byte index before their bytes.
			else if (box.type === 'jxlp') parts.push(b.subarray(box.start + 4, box.end));
		}
		codestream = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		parts.reduce((at, p) => (codestream.set(p, at), at + p.length), 0);
		if (!startsWith(codestream, JXL_SIGNATURE)) return null;
	}

	const bits = new Bits(codestream);
	let header: JxlHeader;
	try {
		bits.skip(16);
		header = readJxlHeader(bits);
	} catch (e) {
		if (e instanceof Unreadable) return null;
		throw e;
	}
	const [width, height] =
		header.orientation > 4 ? [header.height, header.width] : [header.width, header.height];
	if (!header.animation) return info('jxl', width, height, 1, null);
	try {
		const { frames, ticks } = walkJxlFrames(bits, header);
		const { tpsNumerator, tpsDenominator } = header.animation;
		return info('jxl', width, height, frames, (ticks * tpsDenominator) / tpsNumerator, true);
	} catch (e) {
		if (e instanceof Unreadable) return info('jxl', width, height, null, null, true);
		throw e;
	}
}

interface JxlHeader {
	/** As stored, before orientation. */
	width: number;
	height: number;
	orientation: number;
	animation: { tpsNumerator: number; tpsDenominator: number; timecodes: boolean } | null;
	extraChannels: number;
	xyb: boolean;
	/** Where nothing more can be walked: an ICC profile, or a preview frame, comes first. */
	unwalkable: boolean;
}

/** The size header, image metadata and transform data, as libjxl and jxl-oxide read them. */
function readJxlHeader(bits: Bits): JxlHeader {
	const size = () => bits.u32([1, 9], [1, 13], [1, 18], [1, 30]);
	const div8 = bits.bool();
	const height = div8 ? 8 * (1 + bits.read(5)) : size();
	const ratio = bits.read(3);
	const width = ratio ? widthOfRatio(ratio, height) : div8 ? 8 * (1 + bits.read(5)) : size();

	let orientation = 1;
	let animation: JxlHeader['animation'] = null;
	let preview = false;
	let extraChannels = 0;
	let xyb = true;
	let icc = false;
	if (!bits.bool()) {
		const extraFields = bits.bool();
		if (extraFields) {
			orientation = 1 + bits.read(3);
			if (bits.bool()) {
				// Intrinsic size: a size header of its own.
				const d8 = bits.bool();
				if (d8) bits.read(5);
				else size();
				if (bits.read(3) === 0) {
					if (d8) bits.read(5);
					else size();
				}
			}
			preview = bits.bool();
			if (preview) {
				const d8 = bits.bool();
				const previewSize = () =>
					d8 ? bits.u32(16, 32, [1, 5], [33, 9]) : bits.u32([1, 6], [65, 8], [321, 10], [1345, 12]);
				previewSize();
				if (bits.read(3) === 0) previewSize();
			}
			if (bits.bool()) {
				const tpsNumerator = bits.u32(100, 1000, [1, 10], [1, 30]);
				const tpsDenominator = bits.u32(1, 1001, [1, 8], [1, 10]);
				bits.u32(0, [0, 3], [0, 16], [0, 32]); // loops
				animation = { tpsNumerator, tpsDenominator, timecodes: bits.bool() };
			}
		}
		bitDepth(bits);
		bits.bool(); // 16-bit buffers suffice
		extraChannels = bits.u32(0, 1, [2, 4], [1, 12]);
		for (let i = 0; i < extraChannels; i++) {
			if (bits.bool()) continue; // a default alpha channel
			const type = bits.enum();
			bitDepth(bits);
			bits.u32(0, 3, 4, [1, 3]); // dim_shift
			bits.name();
			if (type === 0)
				bits.bool(); // alpha_associated
			else if (type === 2)
				bits.f16s(4); // spot colour
			else if (type === 5) bits.u32(1, [0, 2], [3, 4], [19, 8]); // CFA channel
		}
		xyb = bits.bool();
		icc = colourEncoding(bits);
		if (extraFields && !bits.bool()) {
			// Tone mapping: intensity target, min nits, relative to max display, linear below.
			bits.f16s(2);
			bits.bool();
			bits.f16s(1);
		}
		bits.extensions();
	}
	if (!bits.bool()) {
		// Custom transform data: an opsin inverse matrix, then upsampling weights.
		if (xyb && !bits.bool()) bits.f16s(16);
		const mask = bits.read(3);
		if (mask & 1) bits.f16s(15);
		if (mask & 2) bits.f16s(55);
		if (mask & 4) bits.f16s(210);
	}
	return { width, height, orientation, animation, extraChannels, xyb, unwalkable: icc || preview };
}

function widthOfRatio(ratio: number, height: number): number {
	const [num, den] = [
		[1, 1],
		[12, 10],
		[4, 3],
		[3, 2],
		[16, 9],
		[5, 4],
		[2, 1]
	][ratio - 1];
	return Math.floor((height * num) / den);
}

function bitDepth(bits: Bits): void {
	if (bits.bool()) {
		bits.u32(32, 16, 24, [1, 6]);
		bits.read(4);
	} else {
		bits.u32(8, 10, 12, [1, 6]);
	}
}

/** Reads a colour encoding; true when an ICC profile follows the headers. */
function colourEncoding(bits: Bits): boolean {
	if (bits.bool()) return false;
	const icc = bits.bool();
	const space = bits.enum();
	if (icc) return true;
	const customxy = () => {
		for (let i = 0; i < 2; i++) bits.u32([0, 19], [524288, 19], [1048576, 20], [2097152, 21]);
	};
	const [XYB, GREY, CUSTOM] = [2, 1, 2];
	if (space !== XYB && bits.enum() === CUSTOM) customxy();
	if (space !== XYB && space !== GREY && bits.enum() === CUSTOM)
		for (let i = 0; i < 3; i++) customxy();
	if (bits.bool())
		bits.read(24); // gamma
	else bits.enum(); // transfer function
	bits.enum(); // rendering intent
	return false;
}

const [REGULAR, LF_FRAME, REFERENCE_ONLY, SKIP_PROGRESSIVE] = [0, 1, 2, 3];
const [REPLACE, BLEND, MUL_ADD, MUL] = [0, 2, 3, 4];
const USE_LF_FRAME = 0x20;
const CROP: [number, number][] = [
	[0, 8],
	[256, 11],
	[2304, 14],
	[18688, 30]
];

/**
 * Walks every frame from the byte after the headers: its header and table of
 * contents, then past its sections. Counts the frames shown — regular and
 * skip-progressive ones lasting a tick or more, and the last — and their ticks.
 */
function walkJxlFrames(bits: Bits, header: JxlHeader): { frames: number; ticks: number } {
	if (header.unwalkable) throw new Unreadable('an ICC profile or a preview comes first');
	bits.zeroPadToByte();
	const hasExtraChannels = header.extraChannels > 0;
	let frames = 0;
	let ticks = 0;
	for (;;) {
		let type = REGULAR;
		let modular = false;
		let upsampling = 1;
		let groupShift = 1;
		let passes = 1;
		let lfLevel = 0;
		let [x0, y0, width, height] = [0, 0, header.width, header.height];
		let crop = false;
		let duration = 0;
		let last = true;
		if (!bits.bool()) {
			type = bits.read(2);
			modular = bits.bool();
			const flags = bits.u64();
			const useLf = Math.floor(flags / USE_LF_FRAME) % 2 === 1;
			const ycbcr = !header.xyb && bits.bool();
			if (ycbcr && !useLf) bits.read(6); // JPEG upsampling, three channels
			if (!useLf) {
				upsampling = bits.u32(1, 2, 4, 8);
				for (let i = 0; i < header.extraChannels; i++) bits.u32(1, 2, 4, 8);
			}
			if (modular) groupShift = bits.read(2);
			if (header.xyb && !modular) bits.read(6); // x and b quantization matrix scales
			if (type !== REFERENCE_ONLY) {
				passes = bits.u32(1, 2, 3, [4, 3]);
				if (passes !== 1) {
					const downsampled = bits.u32(0, 1, 2, [3, 1]);
					bits.read(2 * (passes - 1)); // shifts
					for (let i = 0; i < downsampled; i++) bits.u32(1, 2, 4, 8);
					for (let i = 0; i < downsampled; i++) bits.u32(0, 1, 2, [0, 3]);
				}
			}
			if (type === LF_FRAME) lfLevel = 1 + bits.read(2);
			if (type !== LF_FRAME) crop = bits.bool();
			if (crop) {
				const unpack = (u: number) => (u % 2 ? -(u + 1) / 2 : u / 2);
				if (type !== REFERENCE_ONLY) {
					x0 = unpack(bits.u32(...CROP));
					y0 = unpack(bits.u32(...CROP));
				}
				width = bits.u32(...CROP);
				height = bits.u32(...CROP);
			}
			const wholeCanvas =
				x0 <= 0 && y0 <= 0 && x0 + width >= header.width && y0 + height >= header.height;
			const resetsCanvas = (mode: number) => mode === REPLACE && (!crop || wholeCanvas);
			const blending = (contextMode: number | null) => {
				const mode = bits.u32(0, 1, 2, [3, 2]);
				const alpha = hasExtraChannels && (mode === BLEND || mode === MUL_ADD);
				if (alpha) bits.u32(0, 1, 2, [3, 3]); // alpha channel
				if (alpha || mode === MUL) bits.bool(); // clamp
				if (!resetsCanvas(contextMode ?? mode)) bits.read(2); // source
				return mode;
			};
			const normal = type === REGULAR || type === SKIP_PROGRESSIVE;
			let mode = REPLACE;
			if (normal) {
				mode = blending(null);
				for (let i = 0; i < header.extraChannels; i++) blending(mode);
				if (header.animation) duration = bits.u32(0, 1, [0, 8], [0, 32]);
				if (header.animation?.timecodes) bits.read(32);
			}
			last = normal ? bits.bool() : false;
			const saveAsReference = type !== LF_FRAME && !last ? bits.read(2) : 0;
			if (
				type === REFERENCE_ONLY ||
				(resetsCanvas(mode) &&
					!last &&
					(duration === 0 || saveAsReference !== 0) &&
					type !== LF_FRAME)
			) {
				bits.bool(); // save before the colour transform
			}
			bits.name();
			restorationFilter(bits, modular);
			bits.extensions();
		}

		// The table of contents: how many sections, then each one's size.
		const along = (n: number) => {
			if (upsampling > 1) n = Math.ceil(n / upsampling);
			return lfLevel ? Math.ceil(n / 8 ** lfLevel) : n;
		};
		const groupDim = 128 << groupShift;
		const count = (dim: number) => Math.ceil(along(width) / dim) * Math.ceil(along(height) / dim);
		const groups = count(groupDim);
		const sections = groups === 1 && passes === 1 ? 1 : 2 + count(groupDim * 8) + groups * passes;
		if (bits.bool()) throw new Unreadable('a permuted table of contents');
		bits.zeroPadToByte();
		let bytes = 0;
		for (let i = 0; i < sections; i++)
			bytes += bits.u32([0, 10], [1024, 14], [17408, 22], [4211712, 30]);
		bits.zeroPadToByte();
		bits.skip(8 * bytes);

		const normal = type === REGULAR || type === SKIP_PROGRESSIVE;
		if (normal) ticks += duration;
		if (normal && (duration > 0 || last)) frames++;
		if (last) break;
	}
	if (bits.position !== bits.bytes.length * 8) throw new Unreadable('bytes after the last frame');
	return { frames, ticks };
}

/** A frame's restoration filter: Gabor-like smoothing and the edge-preserving filter. */
function restorationFilter(bits: Bits, modular: boolean): void {
	if (bits.bool()) return;
	if (bits.bool() && bits.bool()) bits.f16s(6); // custom Gabor weights
	if (bits.read(2) > 0) {
		if (!modular && bits.bool()) bits.f16s(8); // sharpness
		if (bits.bool()) {
			bits.f16s(3); // channel scales …
			bits.read(32); // … and two that are ignored
		}
		if (bits.bool()) bits.f16s(modular ? 3 : 4); // sigma
		if (modular) bits.f16s(1); // sigma for modular
	}
	bits.extensions();
}
