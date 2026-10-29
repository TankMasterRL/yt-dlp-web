// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeGif } from '../../../tests/helpers/gif';
import { GifEncoder } from './gif';
import { buildPalette, type Palette } from './quantize';

type RGB = [number, number, number];
const RED: RGB = [255, 0, 0];
const GREEN: RGB = [0, 255, 0];
const BLUE: RGB = [0, 0, 255];
const WHITE: RGB = [255, 255, 255];

/** A width × height RGBA frame of `fill`, with `paint` overriding single pixels. */
function frame(width: number, height: number, fill: RGB, paint: [number, number, RGB][] = []) {
	const out = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i++) out.set([...fill, 255], i * 4);
	for (const [x, y, rgb] of paint) out.set([...rgb, 255], (y * width + x) * 4);
	return out;
}

function encode(
	width: number,
	height: number,
	frames: [Uint8ClampedArray, number][],
	palette: Palette = buildPalette(frames.map(([f]) => f))
): Uint8Array {
	const encoder = new GifEncoder({ width, height, palette });
	for (const [pixels, delay] of frames) encoder.addFrame(pixels, delay);
	const chunks = encoder.finish();
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

/** Deterministic noise: every pixel one of `colors` colors. */
function noise(width: number, height: number, colors: number, seed = 1): Uint8ClampedArray {
	const out = new Uint8ClampedArray(width * height * 4);
	let state = seed;
	for (let i = 0; i < width * height; i++) {
		state = (state * 1103515245 + 12345) >>> 0;
		const c = (state >>> 16) % colors;
		out.set([(c * 47) % 256, (c * 89) % 256, (c * 151) % 256, 255], i * 4);
	}
	return out;
}

describe('GifEncoder', () => {
	it('writes a looping GIF89a with the frames, their size and their delays', () => {
		const bytes = encode(4, 3, [
			[frame(4, 3, RED), 10],
			[frame(4, 3, GREEN), 20],
			[frame(4, 3, BLUE), 7]
		]);
		expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('GIF89a');
		const gif = decodeGif(bytes);
		expect(gif).toMatchObject({ width: 4, height: 3, loop: 0 });
		expect(gif.frames.map((f) => f.delay)).toEqual([10, 20, 7]);
		expect([...gif.frames[1].canvas.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
	});

	it('reproduces a picture of few colors exactly, pixel for pixel', () => {
		const pictures = [
			frame(5, 4, WHITE, [
				[0, 0, RED],
				[4, 3, BLUE],
				[2, 1, GREEN]
			]),
			frame(5, 4, BLUE, [[1, 2, WHITE]])
		];
		const gif = decodeGif(
			encode(5, 4, [
				[pictures[0], 5],
				[pictures[1], 5]
			])
		);
		expect(gif.frames.map((f) => f.canvas)).toEqual(pictures);
	});

	it('stores only what changed, and shows exactly the new picture', () => {
		const first = frame(10, 8, WHITE);
		const second = frame(10, 8, WHITE, [
			[3, 2, RED],
			[5, 4, RED]
		]);
		const gif = decodeGif(
			encode(10, 8, [
				[first, 4],
				[second, 4]
			])
		);
		expect(gif.frames[1].rect).toEqual({ x: 3, y: 2, width: 3, height: 3 });
		// Unchanged pixels inside the region are transparent: the old ones show through.
		const { transparentIndex, indices } = gif.frames[1];
		expect(transparentIndex).not.toBeNull();
		expect(indices.filter((i) => i === transparentIndex)).toHaveLength(3 * 3 - 2);
		expect(gif.frames[1].disposal).toBe(1);
		expect(gif.frames[1].canvas).toEqual(second);
	});

	it('folds a frame that changes nothing into the delay of the one before', () => {
		const still = frame(6, 6, GREEN);
		const gif = decodeGif(
			encode(6, 6, [
				[still, 10],
				[still, 10],
				[still, 10],
				[frame(6, 6, RED), 5]
			])
		);
		expect(gif.frames.map((f) => f.delay)).toEqual([30, 5]);
	});

	it('survives LZW tables filling up, many times over, with 12-bit codes', () => {
		const pictures = [noise(200, 150, 250, 1), noise(200, 150, 250, 2)];
		const palette = buildPalette(pictures);
		expect(palette.exact).toBe(true);
		const gif = decodeGif(
			encode(
				200,
				150,
				[
					[pictures[0], 3],
					[pictures[1], 3]
				],
				palette
			)
		);
		expect(gif.minCodeSizes).toEqual([8, 8]);
		// Compared byte by byte: a failing toEqual of whole frames takes minutes to diff.
		const same = (a: Uint8ClampedArray, b: Uint8ClampedArray) => a.every((v, i) => v === b[i]);
		expect(gif.frames.map((f, i) => same(f.canvas, pictures[i]))).toEqual([true, true]);
	});

	it('sizes the color table and codes to the palette', () => {
		const pictures = [frame(3, 3, RED), frame(3, 3, BLUE)];
		const gif = decodeGif(
			encode(3, 3, [
				[pictures[0], 2],
				[pictures[1], 2]
			])
		);
		// Two colors and the transparent index: a table of 4, the smallest LZW codes.
		expect(gif.globalPalette).toHaveLength(4 * 3);
		expect(gif.minCodeSizes).toEqual([2, 2]);
		expect(gif.frames.map((f) => f.canvas)).toEqual(pictures);
	});

	it('handles a single pixel', () => {
		const gif = decodeGif(encode(1, 1, [[frame(1, 1, WHITE), 100]]));
		expect(gif.frames).toHaveLength(1);
		expect([...gif.frames[0].canvas]).toEqual([255, 255, 255, 255]);
	});

	it('comes close to a picture with more colors than GIF holds', () => {
		const width = 96;
		const height = 64;
		const picture = new Uint8ClampedArray(width * height * 4);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				picture.set([x * 2.6, y * 4, 255 - x * 2, 255], (y * width + x) * 4);
			}
		}
		const gif = decodeGif(encode(width, height, [[picture, 10]]));
		const shown = gif.frames[0].canvas;
		let error = 0;
		for (let i = 0; i < picture.length; i += 4) {
			for (let c = 0; c < 3; c++) error += Math.abs(shown[i + c] - picture[i + c]);
		}
		expect(error / (width * height * 3)).toBeLessThan(12);
	});

	it('keeps long stills within what a GIF delay can say', () => {
		const still = frame(2, 2, RED);
		const frames: [Uint8ClampedArray, number][] = [
			[still, 40_000],
			[still, 40_000],
			[frame(2, 2, BLUE), 1]
		];
		const gif = decodeGif(encode(2, 2, frames));
		expect(gif.frames.map((f) => f.delay).reduce((a, b) => a + b)).toBe(80_001);
		expect(Math.max(...gif.frames.map((f) => f.delay))).toBeLessThanOrEqual(65_535);
		expect(gif.frames.at(-1)!.canvas).toEqual(frame(2, 2, BLUE));
	});

	it('refuses frames of the wrong size, and frames after the end', () => {
		const encoder = new GifEncoder({
			width: 2,
			height: 2,
			palette: buildPalette([frame(2, 2, RED)])
		});
		expect(() => encoder.addFrame(frame(3, 2, RED), 1)).toThrow(/2 × 2/);
		encoder.addFrame(frame(2, 2, RED), 1);
		encoder.finish();
		expect(() => encoder.addFrame(frame(2, 2, RED), 1)).toThrow(/finished/);
	});
});
