/**
 * An animated PNG (APNG) encoder: RGBA frames in, a looping, lossless,
 * full-color APNG out — the PNG and APNG specifications, nothing borrowed.
 *
 * - Each row is filtered (None, Sub, Up, Average or Paeth, whichever leaves
 *   the smallest residuals) and the frame deflated as a zlib stream by the
 *   browser's CompressionStream.
 * - After the first frame only the rectangle that changed is stored, its
 *   unchanged pixels transparent and blended over the previous frame; a frame
 *   that changes nothing adds its 1/fps to the one before. A frame with
 *   translucent pixels is stored as it is instead, since blending would mix
 *   them with what was there.
 * - Frame timing is exact: delays are counted in 1/fps of a second.
 */

export interface ApngOptions {
	width: number;
	height: number;
	fps: number;
	/** zlib (RFC 1950) compression; CompressionStream('deflate') by default. */
	deflate?: (data: Uint8Array) => Promise<Uint8Array>;
}

/** Image data per IDAT or fdAT chunk: big enough for no overhead, small enough for any reader. */
const CHUNK_BYTES = 1 << 17;
const MAX_DELAY = 0xffff;
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BLEND_SOURCE = 0;
const BLEND_OVER = 1;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c;
});

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

async function compress(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data as Uint8Array<ArrayBuffer>])
		.stream()
		.pipeThrough(new CompressionStream('deflate'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A PNG chunk: length, type, data, CRC of type and data. */
function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

function fields(...values: [bits: 8 | 16 | 32, value: number][]): Uint8Array {
	const out = new Uint8Array(values.reduce((n, [bits]) => n + bits / 8, 0));
	const view = new DataView(out.buffer);
	let at = 0;
	for (const [bits, value] of values) {
		if (bits === 8) view.setUint8(at, value);
		else if (bits === 16) view.setUint16(at, value);
		else view.setUint32(at, value);
		at += bits / 8;
	}
	return out;
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * RGBA rows, each behind its filter type byte: the filter whose residuals
 * are smallest (summed as signed bytes, the usual heuristic) wins the row.
 */
export function filterRows(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
	const stride = width * 4;
	const out = new Uint8Array(height * (stride + 1));
	const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride));
	for (let y = 0; y < height; y++) {
		const row = y * stride;
		const up = row - stride;
		const costs = [0, 0, 0, 0, 0];
		for (let x = 0; x < stride; x++) {
			const v = rgba[row + x];
			const a = x >= 4 ? rgba[row + x - 4] : 0;
			const b = y > 0 ? rgba[up + x] : 0;
			const c = x >= 4 && y > 0 ? rgba[up + x - 4] : 0;
			const residuals = [v, v - a, v - b, v - ((a + b) >> 1), v - paeth(a, b, c)];
			for (let f = 0; f < 5; f++) {
				const r = residuals[f] & 0xff;
				candidates[f][x] = r;
				costs[f] += r < 128 ? r : 256 - r;
			}
		}
		const best = costs.indexOf(Math.min(...costs));
		out[y * (stride + 1)] = best;
		out.set(candidates[best], y * (stride + 1) + 1);
	}
	return out;
}

interface Frame {
	rect: { x: number; y: number; width: number; height: number };
	blend: number;
	/** In frames: 1/fps each. */
	delay: number;
	data: Uint8Array;
}

export class ApngEncoder {
	readonly #width: number;
	readonly #height: number;
	readonly #fps: number;
	readonly #deflate: (data: Uint8Array) => Promise<Uint8Array>;
	readonly #frames: Frame[] = [];
	/** What is on screen after the frames so far. */
	#shown: Uint8ClampedArray | null = null;
	#finished = false;

	constructor({ width, height, fps, deflate = compress }: ApngOptions) {
		this.#width = width;
		this.#height = height;
		this.#fps = fps;
		this.#deflate = deflate;
	}

	/** Adds a width × height frame of RGBA pixels, shown for 1/fps s. */
	async addFrame(rgba: ArrayLike<number>): Promise<void> {
		if (this.#finished) throw new Error('the APNG is finished');
		const [width, height] = [this.#width, this.#height];
		if (rgba.length !== width * height * 4) {
			throw new RangeError(
				`expected a ${width} × ${height} frame (${width * height * 4} bytes), got ${rgba.length} bytes`
			);
		}
		const shown = this.#shown;
		this.#shown = Uint8ClampedArray.from(rgba);
		if (!shown) {
			await this.#push({ x: 0, y: 0, width, height }, BLEND_SOURCE, rgba);
			return;
		}

		let [left, top, right, bottom] = [width, height, -1, -1];
		let opaque = true;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const at = (y * width + x) * 4;
				if (
					rgba[at] === shown[at] &&
					rgba[at + 1] === shown[at + 1] &&
					rgba[at + 2] === shown[at + 2] &&
					rgba[at + 3] === shown[at + 3]
				)
					continue;
				if (rgba[at + 3] !== 255) opaque = false;
				if (x < left) left = x;
				if (x > right) right = x;
				if (y < top) top = y;
				bottom = y;
			}
		}
		const last = this.#frames.at(-1)!;
		if (right < 0) {
			if (last.delay < MAX_DELAY) {
				last.delay++;
				return;
			}
			// Too long to fold in: a transparent pixel carries the time.
			await this.#push({ x: 0, y: 0, width: 1, height: 1 }, BLEND_OVER, [0, 0, 0, 0]);
			return;
		}

		const rect = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
		const region = new Uint8ClampedArray(rect.width * rect.height * 4);
		for (let y = 0; y < rect.height; y++) {
			for (let x = 0; x < rect.width; x++) {
				const at = ((rect.y + y) * width + rect.x + x) * 4;
				const to = (y * rect.width + x) * 4;
				const unchanged =
					opaque &&
					rgba[at] === shown[at] &&
					rgba[at + 1] === shown[at + 1] &&
					rgba[at + 2] === shown[at + 2] &&
					rgba[at + 3] === shown[at + 3];
				// Opaque frames blend over the last one: unchanged pixels become transparent.
				if (!unchanged) {
					region[to] = rgba[at];
					region[to + 1] = rgba[at + 1];
					region[to + 2] = rgba[at + 2];
					region[to + 3] = rgba[at + 3];
				}
			}
		}
		await this.#push(rect, opaque ? BLEND_OVER : BLEND_SOURCE, region);
	}

	/** The APNG's bytes, in order. The encoder takes no frames after this. */
	async finish(): Promise<Uint8Array<ArrayBuffer>[]> {
		if (this.#finished) throw new Error('the APNG is finished');
		this.#finished = true;
		const frames = this.#frames;
		const out: Uint8Array<ArrayBuffer>[] = [Uint8Array.from(SIGNATURE)];
		// 8 bits per channel, RGBA, deflate, adaptive filters, not interlaced.
		out.push(
			chunk(
				'IHDR',
				fields([32, this.#width], [32, this.#height], [8, 8], [8, 6], [8, 0], [8, 0], [8, 0])
			)
		);
		// How many frames, and how often to play them: 0 is forever.
		out.push(chunk('acTL', fields([32, frames.length], [32, 0])));
		let sequence = 0;
		for (const [i, frame] of frames.entries()) {
			const { rect } = frame;
			out.push(
				chunk(
					'fcTL',
					fields(
						[32, sequence++],
						[32, rect.width],
						[32, rect.height],
						[32, rect.x],
						[32, rect.y],
						[16, frame.delay],
						[16, this.#fps],
						[8, 0], // leave it on screen
						[8, frame.blend]
					)
				)
			);
			for (let at = 0; at < frame.data.length; at += CHUNK_BYTES) {
				const piece = frame.data.subarray(at, at + CHUNK_BYTES);
				// The first frame is also the still image older decoders show.
				if (i === 0) {
					out.push(chunk('IDAT', piece));
				} else {
					const data = new Uint8Array(4 + piece.length);
					new DataView(data.buffer).setUint32(0, sequence++);
					data.set(piece, 4);
					out.push(chunk('fdAT', data));
				}
			}
		}
		out.push(chunk('IEND', new Uint8Array()));
		return out;
	}

	async #push(rect: Frame['rect'], blend: number, rgba: ArrayLike<number>): Promise<void> {
		const data = await this.#deflate(filterRows(rgba, rect.width, rect.height));
		this.#frames.push({ rect, blend, delay: 1, data });
	}
}
