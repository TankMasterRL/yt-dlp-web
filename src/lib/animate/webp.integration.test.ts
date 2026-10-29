// @vitest-environment node
/**
 * The WebP muxer with REAL VP8 stills: ffmpeg.wasm's libwebp stands in for
 * the browser's canvas encoder, and ffmpeg's own WebP decoder reads every
 * frame of the animation back (rewrapped as a still: FFmpeg 5.1 cannot play
 * animated WebP). The browser plays the animation itself in the e2e suite.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadFFmpegCore } from '../../../tests/helpers/ffmpeg';
import { concat, mismatches, oracle, psnr } from '../../../tests/helpers/oracle';
import { readAnimatedWebp, stillWebp } from '../../../tests/helpers/webp';
import { WebpEncoder, type StillWebpEncoder } from './webp';

let ffmpeg: ReturnType<typeof oracle>;
beforeAll(async () => {
	ffmpeg = oracle(await loadFFmpegCore());
});

/** libwebp through ffmpeg.wasm: lossy VP8 at quality 75, like a canvas makes. */
const libwebp: StillWebpEncoder = async (pixels, width, height) =>
	ffmpeg.withFile('frame.rgba', pixels as unknown as Uint8Array, (path) => {
		ffmpeg.run([
			...['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', path],
			...['-c:v', 'libwebp', '-quality', '75', '-f', 'webp', '/still.webp']
		]);
		return ffmpeg.take('/still.webp');
	});

describe('animated WebP from real VP8 stills', () => {
	it('carries every still into the animation byte for byte, in order and on time', async () => {
		const [width, height] = [160, 120];
		const source = ffmpeg.lavfi(
			`testsrc2=size=${width}x${height}:rate=10:duration=1`,
			width,
			height
		);
		const stills: Uint8Array[] = [];
		const recording: StillWebpEncoder = async (...args) => {
			const still = await libwebp(...args);
			stills.push(still);
			return still;
		};
		const encoder = new WebpEncoder({ width, height, fps: 10, encodeStill: recording });
		for (const frame of source) await encoder.addFrame(frame);
		const webp = readAnimatedWebp(concat(encoder.finish()));

		expect(webp.frames).toHaveLength(10);
		expect(webp.frames.map((f) => f.duration)).toEqual(Array(10).fill(100));
		for (const [i, frame] of webp.frames.entries()) {
			const shown = ffmpeg.decode(stillWebp(frame), 'webp', width, height)[0];
			// The muxer changed nothing: the frame decodes exactly as its still did …
			expect(mismatches(shown, ffmpeg.decode(stills[i], 'webp', width, height)[0])).toBe(0);
			// … which is the source frame, give or take what lossy VP8 drops.
			expect(psnr(shown, source[i]), `frame ${i}`).toBeGreaterThan(25);
		}
	});
});
