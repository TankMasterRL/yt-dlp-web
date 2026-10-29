// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeApng, unfilter } from '../../../tests/helpers/apng';
import { ApngEncoder, filterRows } from './apng';

type RGB = [number, number, number];

function frame(width: number, height: number, fill: RGB, paint: [number, number, RGB][] = []) {
	const out = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i++) out.set([...fill, 255], i * 4);
	for (const [x, y, rgb] of paint) out.set([...rgb, 255], (y * width + x) * 4);
	return out;
}

/** Deterministic noise that no filter predicts: murmur3's finalizer over the byte index. */
function noise(width: number, height: number, seed: number): Uint8ClampedArray {
	const out = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < out.length; i++) {
		let h = Math.imul(i ^ seed, 0x9e3779b1);
		h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
		h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
		out[i] = i % 4 === 3 ? 255 : (h ^ (h >>> 16)) & 255;
	}
	return out;
}

/** Smooth color: what the row filters are for. */
function gradient(width: number, height: number, shift = 0): Uint8ClampedArray {
	const out = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			out.set([(x * 3 + shift) & 255, (y * 2) & 255, (x + y) & 255, 255], (y * width + x) * 4);
		}
	}
	return out;
}

async function encode(width: number, height: number, frames: Uint8ClampedArray[], fps = 10) {
	const encoder = new ApngEncoder({ width, height, fps });
	for (const f of frames) await encoder.addFrame(f);
	const chunks = await encoder.finish();
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	chunks.reduce((at, c) => (out.set(c, at), at + c.length), 0);
	return out;
}

const same = (a: Uint8ClampedArray, b: Uint8ClampedArray) =>
	a.length === b.length && a.every((v, i) => v === b[i]);

describe('filterRows', () => {
	it('picks a filter per row that the PNG decoder reverses exactly', () => {
		for (const pixels of [noise(37, 9, 3), gradient(37, 9), frame(37, 9, [9, 9, 9])]) {
			const filtered = filterRows(pixels, 37, 9);
			expect(filtered).toHaveLength(9 * (1 + 37 * 4));
			expect(same(new Uint8ClampedArray(unfilter(filtered, 37, 9, 4)), pixels)).toBe(true);
		}
	});

	it('chooses the filter that predicts the picture best', () => {
		// A horizontal ramp: each pixel is its left neighbour plus one — Sub's case.
		const ramp = new Uint8ClampedArray(64 * 2 * 4);
		for (let i = 0; i < 128; i++) ramp.set([i % 64, i % 64, i % 64, 255], i * 4);
		const filtered = filterRows(ramp, 64, 2);
		expect(filtered[0]).toBe(1);
		// Below an identical row, Up leaves nothing at all.
		expect(filtered[1 + 64 * 4]).toBe(2);
	});
});

describe('ApngEncoder', () => {
	it('writes a looping APNG whose frames last 1/fps each, losslessly', async () => {
		const pictures = [gradient(20, 12), noise(20, 12, 1), gradient(20, 12, 50)];
		const apng = decodeApng(await encode(20, 12, pictures, 12));
		expect(apng).toMatchObject({ width: 20, height: 12, colorType: 6, plays: 0 });
		expect(apng.frames.map((f) => f.delay)).toEqual(Array(3).fill({ num: 1, den: 12 }));
		expect(apng.frames.map((f, i) => same(f.canvas, pictures[i]))).toEqual([true, true, true]);
	});

	it('stores only what changed, the rest transparent over the previous frame', async () => {
		const first = frame(10, 8, [255, 255, 255]);
		const second = frame(
			10,
			8,
			[255, 255, 255],
			[
				[3, 2, [255, 0, 0]],
				[5, 4, [255, 0, 0]]
			]
		);
		const apng = decodeApng(await encode(10, 8, [first, second]));
		const changed = apng.frames[1];
		expect(changed.rect).toEqual({ x: 3, y: 2, width: 3, height: 3 });
		expect(changed).toMatchObject({ blend: 1, dispose: 0 });
		const transparent = [...changed.pixels].filter(
			(_, i) => i % 4 === 3 && changed.pixels[i] === 0
		);
		expect(transparent).toHaveLength(3 * 3 - 2);
		expect(same(changed.canvas, second)).toBe(true);
	});

	it('folds a frame that changes nothing into the one before', async () => {
		const still = frame(6, 6, [0, 128, 0]);
		const apng = decodeApng(await encode(6, 6, [still, still, still, frame(6, 6, [9, 9, 9])], 30));
		expect(apng.frames.map((f) => f.delay)).toEqual([
			{ num: 3, den: 30 },
			{ num: 1, den: 30 }
		]);
	});

	it('splits large frames over several chunks', async () => {
		const pictures = [noise(300, 300, 7), noise(300, 300, 8)];
		const apng = decodeApng(await encode(300, 300, pictures));
		expect(apng.dataChunks).toBeGreaterThan(2);
		expect(apng.frames.map((f, i) => same(f.canvas, pictures[i]))).toEqual([true, true]);
	});

	it('keeps translucent pixels as they are, never blending them over the last frame', async () => {
		const first = frame(4, 4, [10, 20, 30]);
		const second = frame(4, 4, [10, 20, 30]);
		second.set([200, 100, 50, 128], 5 * 4);
		const apng = decodeApng(await encode(4, 4, [first, second]));
		expect(apng.frames[1].blend).toBe(0);
		expect([...apng.frames[1].canvas.subarray(20, 24)]).toEqual([200, 100, 50, 128]);
	});

	it('refuses frames of the wrong size', async () => {
		const encoder = new ApngEncoder({ width: 2, height: 2, fps: 10 });
		await expect(encoder.addFrame(frame(3, 2, [0, 0, 0]))).rejects.toThrow(/2 × 2/);
	});
});
