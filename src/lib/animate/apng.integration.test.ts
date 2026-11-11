// @vitest-environment node
/**
 * The APNG encoder checked by a decoder that is not ours: the REAL ffmpeg.wasm
 * (`@ffmpeg/core`) decodes every APNG the encoder writes, frame by frame
 * (compositing changed regions over the frames before), and ffprobe reads its
 * timing. ffmpeg.wasm also renders the moving picture that stands in for video.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadFFmpegCore } from '../../../tests/helpers/ffmpeg';
import { concat, mismatches, oracle } from '../../../tests/helpers/oracle';
import { ApngEncoder } from './apng';

let ffmpeg: ReturnType<typeof oracle>;
beforeAll(async () => {
	ffmpeg = oracle(await loadFFmpegCore());
});

async function encode(width: number, height: number, frames: Uint8ClampedArray[], fps: number) {
	const encoder = new ApngEncoder({ width, height, fps });
	for (const frame of frames) await encoder.addFrame(frame);
	return concat(await encoder.finish());
}

describe('APNGs, as FFmpeg decodes them', () => {
	it('shows every frame of a moving picture exactly, at its timing', async () => {
		const [width, height] = [160, 120];
		const source = ffmpeg.lavfi(
			`testsrc2=size=${width}x${height}:rate=10:duration=1`,
			width,
			height
		);
		const apng = await encode(width, height, source, 10);
		const shown = ffmpeg.decode(apng, 'apng', width, height);
		expect(shown).toHaveLength(10);
		expect(shown.map((frame, i) => mismatches(frame, source[i]))).toEqual(Array(10).fill(0));
		expect(ffmpeg.probe(apng, 'apng', 'packet=duration_time').map(Number)).toEqual(
			Array(10).fill(0.1)
		);
	});

	it('composites changed regions over a still background exactly', async () => {
		const [width, height] = [64, 48];
		// A white square crossing a dark background: most of each frame unchanged.
		const frames = Array.from({ length: 5 }, (_, f) => {
			const out = new Uint8ClampedArray(width * height * 4);
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const inside = x >= f * 8 && x < f * 8 + 12 && y >= 10 && y < 22;
					out.set(inside ? [250, 250, 250, 255] : [20, 30, 60, 255], (y * width + x) * 4);
				}
			}
			return out;
		});
		const shown = ffmpeg.decode(await encode(width, height, frames, 25), 'apng', width, height);
		expect(shown.map((frame, i) => mismatches(frame, frames[i]))).toEqual(Array(5).fill(0));
	});
});
