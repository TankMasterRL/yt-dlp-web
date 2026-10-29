// @vitest-environment node
/**
 * The GIF encoder checked by a decoder that is not ours: the REAL ffmpeg.wasm
 * (`@ffmpeg/core`) decodes every GIF the encoder writes, frame by frame, and
 * ffprobe reads its timing. ffmpeg.wasm also renders the moving test picture
 * that stands in for a video.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadFFmpegCore } from '../../../tests/helpers/ffmpeg';
import { concat, mismatches, oracle, psnr } from '../../../tests/helpers/oracle';
import { GifEncoder } from './gif';
import { buildPalette } from './quantize';

let ffmpeg: ReturnType<typeof oracle>;
beforeAll(async () => {
	ffmpeg = oracle(await loadFFmpegCore());
});

function encode(
	width: number,
	height: number,
	frames: Uint8ClampedArray[],
	delay: number,
	palette = buildPalette(frames.slice(0, 16))
): Uint8Array {
	const encoder = new GifEncoder({ width, height, palette });
	for (const frame of frames) encoder.addFrame(frame, delay);
	return concat(encoder.finish());
}

describe('GIFs, as FFmpeg decodes them', () => {
	it('shows a flat-colored animation exactly as drawn, at its timing', () => {
		const [width, height] = [48, 32];
		// A white square crossing a dark background: few colors, small changes.
		const frames = Array.from({ length: 6 }, (_, f) => {
			const out = new Uint8ClampedArray(width * height * 4);
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const inside = x >= f * 6 && x < f * 6 + 10 && y >= 8 && y < 18;
					out.set(inside ? [250, 250, 250, 255] : [20, 30, 60, 255], (y * width + x) * 4);
				}
			}
			return out;
		});
		const gif = encode(width, height, frames, 8);
		const shown = ffmpeg.decode(gif, 'gif', width, height);
		expect(shown).toHaveLength(frames.length);
		expect(shown.map((frame, i) => mismatches(frame, frames[i]))).toEqual([0, 0, 0, 0, 0, 0]);
		expect(ffmpeg.probe(gif, 'gif', 'packet=duration_time').map(Number)).toEqual(
			Array(6).fill(0.08)
		);
	});

	it('shows every shade of a picture exactly, when they fit in a palette', () => {
		const [width, height] = [16, 15];
		// 240 colors, neighbours a single level apart.
		const shades = new Uint8ClampedArray(width * height * 4);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) shades.set([100 + x, 100 + y, 100, 255], (y * width + x) * 4);
		}
		expect(buildPalette([shades]).exact).toBe(true);
		const [shown] = ffmpeg.decode(encode(width, height, [shades], 10), 'gif', width, height);
		expect(mismatches(shown, shades)).toBe(0);
	});

	it('stays close to a moving picture of far more colors than a GIF holds', () => {
		const [width, height] = [160, 120];
		const source = ffmpeg.lavfi(
			`testsrc2=size=${width}x${height}:rate=10:duration=1`,
			width,
			height
		);
		const palette = buildPalette(source);
		expect(palette.exact).toBe(false);
		const gif = encode(width, height, source, 10, palette);
		const shown = ffmpeg.decode(gif, 'gif', width, height);
		expect(shown).toHaveLength(10);
		for (const [i, frame] of shown.entries()) {
			expect(psnr(frame, source[i]), `frame ${i}`).toBeGreaterThan(36);
		}
		// Only what changes is stored again: well under ten frames stored whole.
		const separately = source.reduce(
			(bytes, frame) => bytes + encode(width, height, [frame], 10, palette).length,
			0
		);
		expect(gif.length).toBeLessThan(separately * 0.75);
	});
});
