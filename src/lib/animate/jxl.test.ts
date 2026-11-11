// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeJxl } from '../../../tests/helpers/jxl';
import { JxlEncoder } from './jxl';

type RGB = [number, number, number];

function frame(width: number, height: number, fill: RGB, paint: [number, number, RGB][] = []) {
	const out = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i++) out.set([...fill, 255], i * 4);
	for (const [x, y, rgb] of paint) out.set([...rgb, 255], (y * width + x) * 4);
	return out;
}

/** Deterministic noise that no predictor guesses: murmur3's finalizer over the byte index. */
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

/** Smooth color, which the gradient predictor guesses well. */
function gradient(width: number, height: number, shift = 0): Uint8ClampedArray {
	const out = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			out.set(
				[(x * 3 + shift) & 255, (y * 2) & 255, (x + y + shift) & 255, 255],
				(y * width + x) * 4
			);
		}
	}
	return out;
}

function encode(width: number, height: number, frames: Uint8ClampedArray[], fps = 10) {
	const encoder = new JxlEncoder({ width, height, fps });
	for (const f of frames) encoder.addFrame(f);
	const chunks = encoder.finish();
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	chunks.reduce((at, c) => (out.set(c, at), at + c.length), 0);
	return out;
}

/** Bytes that differ (a count, not a diff: vitest's diff of large arrays takes minutes). */
const mismatches = (a: Uint8ClampedArray, b: Uint8ClampedArray) =>
	a.length === b.length ? a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0) : -1;

describe('JxlEncoder', () => {
	it('starts with the JPEG XL codestream signature', () => {
		const bytes = encode(4, 4, [gradient(4, 4)]);
		expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0x0a]);
	});

	it('writes a picture that decodes losslessly', () => {
		for (const [width, height] of [
			[1, 1],
			[8, 5],
			[33, 17]
		]) {
			const picture = noise(width, height, width);
			const jxl = decodeJxl(encode(width, height, [picture]));
			expect(jxl).toMatchObject({ width, height });
			expect(jxl.frames.map((f) => mismatches(f.pixels, picture))).toEqual([0]);
		}
	});

	it('copes with flat pictures, whose residuals are all one symbol', () => {
		for (const picture of [
			frame(9, 7, [0, 0, 0]),
			frame(9, 7, [255, 255, 255]),
			frame(9, 7, [3, 200, 77])
		]) {
			const jxl = decodeJxl(encode(9, 7, [picture]));
			expect(mismatches(jxl.frames[0].pixels, picture)).toBe(0);
		}
	});

	it('animates: every frame, one tick of 1/fps each, looping forever', () => {
		const pictures = [gradient(20, 12), noise(20, 12, 1), gradient(20, 12, 90)];
		const jxl = decodeJxl(encode(20, 12, pictures, 12));
		expect(jxl).toMatchObject({ width: 20, height: 12, animated: true, loops: 0 });
		expect(jxl.frames.map((f) => f.ticksTimesTps / 12)).toEqual([1, 1, 1]);
		expect(jxl.frames.map((f, i) => mismatches(f.pixels, pictures[i]))).toEqual([0, 0, 0]);
	});

	it('folds a frame that changes nothing into the one before', () => {
		const still = gradient(6, 6);
		const jxl = decodeJxl(encode(6, 6, [still, still, still, frame(6, 6, [1, 2, 3])], 30));
		expect(jxl.frames.map((f) => f.ticksTimesTps / 30)).toEqual([3, 1]);
	});

	it('spans several groups, and several LF groups', () => {
		for (const [width, height] of [
			[300, 270],
			[2100, 3],
			[5, 520]
		]) {
			const pictures = [noise(width, height, 5), gradient(width, height)];
			const jxl = decodeJxl(encode(width, height, pictures));
			expect(jxl.frames.map((f, i) => mismatches(f.pixels, pictures[i]))).toEqual([0, 0]);
		}
	});

	it('refuses frames of the wrong size, and frames after the end', () => {
		const encoder = new JxlEncoder({ width: 2, height: 2, fps: 10 });
		expect(() => encoder.addFrame(frame(3, 2, [0, 0, 0]))).toThrow(/2 × 2/);
		encoder.addFrame(frame(2, 2, [0, 0, 0]));
		encoder.finish();
		expect(() => encoder.addFrame(frame(2, 2, [0, 0, 0]))).toThrow(/finished/);
	});

	it('codes a flat area as runs, which cost next to nothing', () => {
		const bytes = encode(256, 256, [frame(256, 256, [12, 140, 220])]);
		expect(bytes.length).toBeLessThan(200);
		expect(mismatches(decodeJxl(bytes).frames[0].pixels, frame(256, 256, [12, 140, 220]))).toBe(0);
	});

	it('compresses smooth pictures well below their raw size', () => {
		const bytes = encode(256, 256, [gradient(256, 256)]);
		expect(bytes.length).toBeLessThan(256 * 256 * 3 * 0.25);
	});
});
