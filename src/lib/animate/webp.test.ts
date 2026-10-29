// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readAnimatedWebp } from '../../../tests/helpers/webp';
import { WebpEncoder, type StillWebpEncoder } from './webp';

function chunk(type: string, data: number[]): number[] {
	const size = data.length;
	return [
		...[...type].map((c) => c.charCodeAt(0)),
		size & 255,
		(size >> 8) & 255,
		(size >> 16) & 255,
		size >>> 24,
		...data,
		...(size % 2 ? [0] : [])
	];
}

function riff(...chunks: number[][]): Uint8Array {
	const body = chunks.flat();
	const size = 4 + body.length;
	return Uint8Array.from([
		...'RIFF'.split('').map((c) => c.charCodeAt(0)),
		size & 255,
		(size >> 8) & 255,
		(size >> 16) & 255,
		size >>> 24,
		...'WEBP'.split('').map((c) => c.charCodeAt(0)),
		...body
	]);
}

/**
 * Stills shaped like Chromium's canvas encoder makes them: VP8X, ALPH, then
 * "VP8 " whose bytes say which picture it was (its first pixel), odd-sized.
 */
function fakeStills(): StillWebpEncoder & { calls: number } {
	const encode = vi.fn(async (pixels: Uint8ClampedArray, width: number, height: number) => {
		encode.calls++;
		const vp8x = [0x10, 0, 0, 0, width - 1, 0, 0, height - 1, 0, 0];
		return riff(
			chunk('VP8X', vp8x),
			chunk('ALPH', [1, 2, 3]),
			chunk('VP8 ', [pixels[0], pixels[1], pixels[2]])
		);
	}) as unknown as StillWebpEncoder & { calls: number };
	encode.calls = 0;
	return encode;
}

/** A width × height frame of one color. */
const solid = (width: number, height: number, rgba: number[]) => {
	const out = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < out.length; i += 4) out.set(rgba, i);
	return out;
};

async function encode(
	frames: Uint8ClampedArray[],
	fps: number,
	encodeStill: StillWebpEncoder = fakeStills()
) {
	const encoder = new WebpEncoder({ width: 4, height: 3, fps, encodeStill });
	for (const f of frames) await encoder.addFrame(f);
	const chunks = encoder.finish();
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	chunks.reduce((at, c) => (out.set(c, at), at + c.length), 0);
	return readAnimatedWebp(out);
}

describe('WebpEncoder', () => {
	it('wraps each still in a frame of the animation, looping forever', async () => {
		const webp = await encode(
			[solid(4, 3, [10, 0, 0, 255]), solid(4, 3, [20, 0, 0, 255]), solid(4, 3, [30, 0, 0, 255])],
			30
		);
		expect(webp).toMatchObject({ width: 4, height: 3, loops: 0, flags: { animation: true } });
		// Milliseconds, the rounding carried along: 33, 34, 33.
		expect(webp.frames.map((f) => f.duration)).toEqual([33, 34, 33]);
		expect(webp.frames.map((f) => [f.x, f.y, f.width, f.height, f.noBlend, f.dispose])).toEqual(
			Array(3).fill([0, 0, 4, 3, true, false])
		);
		expect(webp.frames.map((f) => [...f.chunks.at(-1)!.data])).toEqual([
			[10, 0, 0],
			[20, 0, 0],
			[30, 0, 0]
		]);
	});

	it('drops the alpha of opaque frames, and keeps it where it is needed', async () => {
		const opaque = await encode([solid(4, 3, [1, 2, 3, 255])], 10);
		expect(opaque.frames[0].chunks.map((c) => c.type)).toEqual(['VP8 ']);
		expect(opaque.flags.alpha).toBe(false);

		const translucent = await encode(
			[solid(4, 3, [1, 2, 3, 255]), solid(4, 3, [1, 2, 3, 128])],
			10
		);
		expect(translucent.frames.map((f) => f.chunks.map((c) => c.type))).toEqual([
			['VP8 '],
			['ALPH', 'VP8 ']
		]);
		expect(translucent.flags.alpha).toBe(true);
	});

	it('folds a frame that changes nothing into the one before, without encoding it', async () => {
		const stills = fakeStills();
		const still = solid(4, 3, [5, 5, 5, 255]);
		const webp = await encode([still, still, still, solid(4, 3, [6, 6, 6, 255])], 12, stills);
		expect(webp.frames.map((f) => f.duration)).toEqual([83 + 84 + 83, 83]);
		expect(stills.calls).toBe(2);
	});

	it('takes lossless stills too', async () => {
		// VP8L: signature, then width-1 and height-1 in 14 bits each, alpha unused.
		const lossless: StillWebpEncoder = async () => riff(chunk('VP8L', [0x2f, 3, 0x80, 0, 0, 0xaa]));
		const webp = await encode([solid(4, 3, [9, 9, 9, 255])], 10, lossless);
		expect(webp.frames[0].chunks.map((c) => c.type)).toEqual(['VP8L']);
		expect(webp.flags.alpha).toBe(false);
	});

	it('says so when the browser makes something other than a WebP', async () => {
		const png: StillWebpEncoder = async () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
		const encoder = new WebpEncoder({ width: 4, height: 3, fps: 10, encodeStill: png });
		await expect(encoder.addFrame(solid(4, 3, [0, 0, 0, 255]))).rejects.toThrow(
			/did not make a WebP/
		);
	});

	it('refuses frames of the wrong size', async () => {
		const encoder = new WebpEncoder({ width: 4, height: 3, fps: 10, encodeStill: fakeStills() });
		await expect(encoder.addFrame(solid(3, 3, [0, 0, 0, 255]))).rejects.toThrow(/4 × 3/);
	});
});
