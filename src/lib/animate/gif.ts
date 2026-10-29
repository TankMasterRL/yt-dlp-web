/**
 * An animated GIF89a encoder: RGBA frames in, the bytes of a looping GIF out.
 * Pure and synchronous; the animate worker runs it off the main thread.
 *
 * - One global palette (quantize.ts) for every frame, so colors hold steady.
 * - After the first frame, each frame stores only the rectangle that changed,
 *   with the pixels that did not change inside it made transparent: the long
 *   runs compress well, and the previous frame shows through ("do not
 *   dispose"). A frame that changes nothing adds its delay to the one before.
 * - LZW with variable code sizes up to 12 bits, clearing the table when full,
 *   packed into 255-byte sub-blocks — the GIF89a specification, section 22.
 */
import { PaletteMapper, type Palette } from './quantize';

export interface GifOptions {
	width: number;
	height: number;
	/** At most 255 colors: one more index is kept for transparency. */
	palette: Palette;
	/** Times to play; 0 (the default) loops forever. */
	loop?: number;
}

/** The longest delay a GIF frame can carry, in centiseconds. */
const MAX_DELAY = 0xffff;
const DISPOSE_NONE = 1;

class ByteWriter {
	#bytes = new Uint8Array(1024);
	length = 0;

	byte(value: number): void {
		if (this.length === this.#bytes.length) {
			const grown = new Uint8Array(this.#bytes.length * 2);
			grown.set(this.#bytes);
			this.#bytes = grown;
		}
		this.#bytes[this.length++] = value;
	}

	u16(value: number): void {
		this.byte(value & 0xff);
		this.byte(value >> 8);
	}

	bytes(values: ArrayLike<number>): void {
		for (let i = 0; i < values.length; i++) this.byte(values[i]);
	}

	result(): Uint8Array<ArrayBuffer> {
		return this.#bytes.slice(0, this.length);
	}
}

/** LZW-compresses palette indices into GIF image data: code size, sub-blocks, terminator. */
class LzwEncoder {
	// (prefix code << 8 | next index) → code, valid while its stamp is the current one.
	readonly #codes = new Int16Array(1 << 20);
	readonly #stamps = new Uint32Array(1 << 20);
	#generation = 0;

	encode(indices: Uint8Array, minCodeSize: number, out: ByteWriter): void {
		const clear = 1 << minCodeSize;
		const end = clear + 1;
		let codeSize = minCodeSize + 1;
		let next = end + 1;
		this.#generation++;

		const block = new Uint8Array(255);
		let blockLength = 0;
		let bits = 0;
		let bitCount = 0;
		const emit = (code: number) => {
			bits |= code << bitCount;
			bitCount += codeSize;
			while (bitCount >= 8) {
				block[blockLength++] = bits & 0xff;
				bits >>>= 8;
				bitCount -= 8;
				if (blockLength === 255) {
					out.byte(255);
					out.bytes(block);
					blockLength = 0;
				}
			}
		};

		out.byte(minCodeSize);
		emit(clear);
		let prefix = indices[0];
		for (let i = 1; i < indices.length; i++) {
			const index = indices[i];
			const key = (prefix << 8) | index;
			if (this.#stamps[key] === this.#generation) {
				prefix = this.#codes[key];
				continue;
			}
			emit(prefix);
			if (next < 4096) {
				this.#codes[key] = next++;
				this.#stamps[key] = this.#generation;
				// The decoder, one entry behind, widens its codes as it reads this one.
				if (next > 1 << codeSize) codeSize++;
			} else {
				emit(clear);
				this.#generation++;
				codeSize = minCodeSize + 1;
				next = end + 1;
			}
			prefix = index;
		}
		emit(prefix);
		emit(end);
		if (bitCount > 0) block[blockLength++] = bits & 0xff;
		if (blockLength) {
			out.byte(blockLength);
			out.bytes(block.subarray(0, blockLength));
		}
		out.byte(0);
	}
}

interface PendingFrame {
	delay: number;
	transparent: boolean;
	/** Image descriptor and image data, ready to follow its graphic control extension. */
	image: Uint8Array<ArrayBuffer>;
}

export class GifEncoder {
	readonly #width: number;
	readonly #height: number;
	readonly #mapper: PaletteMapper;
	readonly #dither: boolean;
	readonly #transparent: number;
	readonly #minCodeSize: number;
	readonly #lzw = new LzwEncoder();
	readonly #chunks: Uint8Array<ArrayBuffer>[] = [];
	/** The palette indices on screen after the frames so far. */
	#shown: Uint8Array | null = null;
	#pending: PendingFrame | null = null;
	#finished = false;

	constructor({ width, height, palette, loop = 0 }: GifOptions) {
		const count = palette.colors.length / 3;
		if (count < 1 || count > 255)
			throw new RangeError(`a GIF palette holds 1 to 255 colors, not ${count}`);
		this.#width = width;
		this.#height = height;
		this.#mapper = new PaletteMapper(palette.colors);
		this.#dither = !palette.exact;
		this.#transparent = count;
		// The table holds the colors and the transparent index, in a power of two.
		const tableBits = Math.max(1, Math.ceil(Math.log2(count + 1)));
		this.#minCodeSize = Math.max(2, tableBits);

		const head = new ByteWriter();
		head.bytes([...'GIF89a'].map((c) => c.charCodeAt(0)));
		head.u16(width);
		head.u16(height);
		// Global color table, 8 bits per channel, of 2^tableBits entries.
		head.byte(0x80 | (7 << 4) | (tableBits - 1));
		head.byte(0); // background color index
		head.byte(0); // square pixels
		head.bytes(palette.colors);
		for (let i = palette.colors.length; i < 3 << tableBits; i++) head.byte(0);
		// NETSCAPE2.0: how often to play.
		head.bytes([0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1]);
		head.u16(loop);
		head.byte(0);
		this.#chunks.push(head.result());
	}

	/** Adds a width × height frame of RGBA pixels, shown for `delay` centiseconds. */
	addFrame(rgba: ArrayLike<number>, delay: number): void {
		if (this.#finished) throw new Error('the GIF is finished');
		const [width, height] = [this.#width, this.#height];
		if (rgba.length !== width * height * 4) {
			throw new RangeError(
				`expected a ${width} × ${height} frame (${width * height * 4} bytes), got ${rgba.length} bytes`
			);
		}
		const indices = new Uint8Array(width * height);
		this.#mapper.map(rgba, width, indices, this.#dither);

		const shown = this.#shown;
		this.#shown = indices;
		if (!shown) {
			this.#queue({ x: 0, y: 0, width, height }, indices, false, delay);
			return;
		}

		let [left, top, right, bottom] = [width, height, -1, -1];
		for (let y = 0; y < height; y++) {
			for (let x = 0, at = y * width; x < width; x++, at++) {
				if (indices[at] === shown[at]) continue;
				if (x < left) left = x;
				if (x > right) right = x;
				if (y < top) top = y;
				bottom = y;
			}
		}
		if (right < 0) {
			const pending = this.#pending!;
			if (pending.delay + delay <= MAX_DELAY) {
				pending.delay += delay;
				return;
			}
			// Too long to fold in: a one-pixel frame that changes nothing carries it.
			this.#queue(
				{ x: 0, y: 0, width: 1, height: 1 },
				Uint8Array.of(this.#transparent),
				true,
				delay
			);
			return;
		}

		const rect = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
		const region = new Uint8Array(rect.width * rect.height);
		for (let y = 0, i = 0; y < rect.height; y++) {
			const row = (rect.y + y) * width + rect.x;
			for (let x = 0; x < rect.width; x++, i++) {
				const index = indices[row + x];
				region[i] = index === shown[row + x] ? this.#transparent : index;
			}
		}
		this.#queue(rect, region, true, delay);
	}

	/** The GIF's bytes, in order. The encoder takes no frames after this. */
	finish(): Uint8Array<ArrayBuffer>[] {
		if (!this.#finished) {
			this.#flush();
			this.#chunks.push(Uint8Array.of(0x3b));
			this.#finished = true;
		}
		return this.#chunks;
	}

	/** Encodes a frame, held back until the next one shows whether its delay grows. */
	#queue(
		rect: { x: number; y: number; width: number; height: number },
		indices: Uint8Array,
		transparent: boolean,
		delay: number
	): void {
		this.#flush();
		const image = new ByteWriter();
		image.byte(0x2c);
		image.u16(rect.x);
		image.u16(rect.y);
		image.u16(rect.width);
		image.u16(rect.height);
		image.byte(0); // no local color table, not interlaced
		this.#lzw.encode(indices, this.#minCodeSize, image);
		this.#pending = { delay: Math.min(delay, MAX_DELAY), transparent, image: image.result() };
	}

	#flush(): void {
		const pending = this.#pending;
		if (!pending) return;
		const control = new ByteWriter();
		control.bytes([0x21, 0xf9, 4, (DISPOSE_NONE << 2) | (pending.transparent ? 1 : 0)]);
		control.u16(pending.delay);
		control.byte(this.#transparent);
		control.byte(0);
		this.#chunks.push(control.result(), pending.image);
		this.#pending = null;
	}
}
