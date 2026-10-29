/**
 * Animated WebP: each frame is compressed by the browser's own WebP encoder
 * (lossy VP8, as a still image), and this module muxes the stills into one
 * animation — the WebP container specification's VP8X, ANIM and ANMF chunks.
 *
 * - Frames fill the canvas and replace what was there (no blending): VP8 has
 *   no notion of "unchanged", and full frames keep the muxer simple.
 * - An opaque frame's ALPH chunk (canvas encoders write one regardless) is
 *   dropped; a translucent one keeps it, and the file says it has alpha.
 * - Durations are milliseconds with the rounding carried along, and a frame
 *   that changes nothing adds its time to the one before, unencoded.
 */
import { delayAt } from './clip';

/** Compresses one RGBA frame into a still WebP file (the browser's encoder, in the app). */
export type StillWebpEncoder = (
	pixels: Uint8ClampedArray,
	width: number,
	height: number
) => Promise<Uint8Array>;

export interface WebpOptions {
	width: number;
	height: number;
	fps: number;
	encodeStill: StillWebpEncoder;
}

interface Chunk {
	type: string;
	data: Uint8Array;
}

interface Frame {
	chunks: Chunk[];
	/** Milliseconds. */
	duration: number;
}

/** A frame's duration is 24 bits of milliseconds. */
const MAX_DURATION = 0xffffff;
const ANIMATION_FLAG = 0x02;
const ALPHA_FLAG = 0x10;
const NO_BLEND = 0x02;

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u24 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];

function readChunks(bytes: Uint8Array): Chunk[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const chunks: Chunk[] = [];
	for (let at = 0; at + 8 <= bytes.length;) {
		const type = String.fromCharCode(...bytes.subarray(at, at + 4));
		const size = view.getUint32(at + 4, true);
		chunks.push({ type, data: bytes.subarray(at + 8, at + 8 + size) });
		at += 8 + size + (size % 2);
	}
	return chunks;
}

/** The chunks of a still WebP file, or null if it is not one. */
function stillChunks(bytes: Uint8Array): Chunk[] | null {
	const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
	if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return null;
	return readChunks(bytes.subarray(12));
}

function chunkBytes(type: string, data: ArrayLike<number>): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(8 + data.length + (data.length % 2));
	out.set(ascii(type));
	new DataView(out.buffer).setUint32(4, data.length, true);
	out.set(data, 8);
	return out;
}

const isOpaque = (rgba: ArrayLike<number>) => {
	for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return false;
	return true;
};

/** Whether a VP8L bitstream says it uses alpha (bit 28 of its header). */
const vp8lAlpha = (data: Uint8Array) => data.length >= 5 && ((data[4] >> 4) & 1) === 1;

export class WebpEncoder {
	readonly #width: number;
	readonly #height: number;
	readonly #fps: number;
	readonly #encodeStill: StillWebpEncoder;
	readonly #frames: Frame[] = [];
	#previous: Uint8ClampedArray | null = null;
	#index = 0;

	constructor({ width, height, fps, encodeStill }: WebpOptions) {
		this.#width = width;
		this.#height = height;
		this.#fps = fps;
		this.#encodeStill = encodeStill;
	}

	/** Adds a width × height frame of RGBA pixels, shown for 1/fps s. */
	async addFrame(rgba: Uint8ClampedArray): Promise<void> {
		const [width, height] = [this.#width, this.#height];
		if (rgba.length !== width * height * 4) {
			throw new RangeError(
				`expected a ${width} × ${height} frame (${width * height * 4} bytes), got ${rgba.length} bytes`
			);
		}
		const duration = delayAt(this.#index++, this.#fps, 1000);
		const last = this.#frames.at(-1);
		const previous = this.#previous;
		if (
			last &&
			previous &&
			last.duration + duration <= MAX_DURATION &&
			previous.every((v, i) => v === rgba[i])
		) {
			last.duration += duration;
			return;
		}
		this.#previous = rgba.slice();
		const chunks = stillChunks(await this.#encodeStill(rgba, width, height));
		const image = chunks?.filter((c) => c.type === 'VP8 ' || c.type === 'VP8L') ?? [];
		if (!chunks || image.length !== 1) {
			throw new Error('The browser did not make a WebP image');
		}
		const alpha = chunks.find((c) => c.type === 'ALPH');
		const keep = alpha && image[0].type === 'VP8 ' && !isOpaque(rgba) ? [alpha] : [];
		this.#frames.push({ chunks: [...keep, image[0]], duration });
	}

	/** The animation's bytes, in order. */
	finish(): Uint8Array<ArrayBuffer>[] {
		const [width, height] = [this.#width, this.#height];
		const alpha = this.#frames.some((f) =>
			f.chunks.some((c) => c.type === 'ALPH' || (c.type === 'VP8L' && vp8lAlpha(c.data)))
		);
		const body: Uint8Array<ArrayBuffer>[] = [
			chunkBytes('VP8X', [
				ANIMATION_FLAG | (alpha ? ALPHA_FLAG : 0),
				0,
				0,
				0,
				...u24(width - 1),
				...u24(height - 1)
			]),
			// Background colour (unused: every frame fills the canvas), loop forever.
			chunkBytes('ANIM', [0, 0, 0, 0, 0, 0])
		];
		for (const frame of this.#frames) {
			const data = frame.chunks.map((c) => chunkBytes(c.type, c.data));
			const header = [
				...u24(0), // x / 2
				...u24(0), // y / 2
				...u24(width - 1),
				...u24(height - 1),
				...u24(frame.duration),
				NO_BLEND // and keep it on screen: the next frame covers it anyway
			];
			const payload = new Uint8Array(header.length + data.reduce((n, d) => n + d.length, 0));
			payload.set(header);
			data.reduce((at, d) => (payload.set(d, at), at + d.length), header.length);
			body.push(chunkBytes('ANMF', payload));
		}
		const size = 4 + body.reduce((n, c) => n + c.length, 0);
		const head = new Uint8Array(12);
		head.set(ascii('RIFF'));
		new DataView(head.buffer).setUint32(4, size, true);
		head.set(ascii('WEBP'), 8);
		return [head, ...body];
	}
}

/** Whether this browser's canvases make WebP (some make PNG instead, quietly). */
export async function canvasWebpSupported(): Promise<boolean> {
	if (typeof OffscreenCanvas !== 'function') return false;
	try {
		const canvas = new OffscreenCanvas(1, 1);
		canvas.getContext('2d');
		return (await canvas.convertToBlob({ type: 'image/webp' })).type === 'image/webp';
	} catch {
		return false;
	}
}

/**
 * The browser's WebP encoder, through an OffscreenCanvas (workers have one):
 * `quality` 1-100 as libwebp's quality factor. Some browsers' canvases cannot
 * make WebP and quietly make PNG instead, which the encoder reports.
 */
export function canvasWebpEncoder(quality: number): StillWebpEncoder {
	let canvas: OffscreenCanvas | null = null;
	return async (pixels, width, height) => {
		canvas ??= new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d');
		if (!context) throw new Error('This browser gives workers no 2D canvas');
		context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
		const blob = await canvas.convertToBlob({ type: 'image/webp', quality: quality / 100 });
		return new Uint8Array(await blob.arrayBuffer());
	};
}
