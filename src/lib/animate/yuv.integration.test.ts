// @vitest-environment node
/**
 * The I420 the app hands the AV1 encoder, read back by FFmpeg's own
 * converter (swscale) as the AVIF says to read it: BT.709, limited range.
 * Read as BT.601 (what Firefox converts RGBA with) or full range, it comes
 * out plainly wrong — the error the AVIF's colours must not carry.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadFFmpegCore } from '../../../tests/helpers/ffmpeg';
import { oracle } from '../../../tests/helpers/oracle';
import { rgbaToI420 } from './yuv';

let ffmpeg: ReturnType<typeof oracle>;
beforeAll(async () => {
	ffmpeg = oracle(await loadFFmpegCore());
});

/** Mean absolute difference per RGB channel. */
function difference(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let sum = 0;
	for (let i = 0; i < a.length; i += 4) {
		sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
	}
	return sum / ((a.length / 4) * 3);
}

/** The top left width × height of a 160 × 120 RGBA picture (testsrc2 makes even sizes only). */
function cut(picture: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
	const out = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		out.set(picture.subarray(y * 160 * 4, (y * 160 + width) * 4), y * width * 4);
	}
	return out;
}

/** FFmpeg's RGBA for an I420 frame, read with `matrix` at `range`, cropped to the picture. */
function readBack(frame: ReturnType<typeof rgbaToI420>, matrix: string, range: string) {
	const { data, width, height, codedWidth, codedHeight } = frame;
	return ffmpeg.withFile('frame.yuv', data, (path) =>
		ffmpeg.rawFrames(
			[
				...['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${codedWidth}x${codedHeight}`],
				...['-i', path, '-vf'],
				`scale=in_color_matrix=${matrix}:in_range=${range}:out_range=full,format=rgba,crop=${width}:${height}:0:0`
			],
			width,
			height
		)
	)[0];
}

/** FFmpeg's own BT.709 limited-range I420 of an even-sized picture: the bar for ours. */
function ffmpegI420(picture: Uint8ClampedArray, width: number, height: number) {
	const data = ffmpeg.withFile('picture.rgba', picture as unknown as Uint8Array, (path) => {
		ffmpeg.run([
			...['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', path],
			...['-vf', 'scale=out_color_matrix=bt709:out_range=limited', '-pix_fmt', 'yuv420p'],
			...['-f', 'rawvideo', '/picture.yuv']
		]);
		return ffmpeg.take('/picture.yuv');
	});
	return { data, width, height, codedWidth: width, codedHeight: height };
}

describe('rgbaToI420, read back by FFmpeg', () => {
	for (const [width, height] of [
		[160, 120],
		[159, 119]
	]) {
		it(`is the picture again at ${width} × ${height}, read as BT.709 limited range`, () => {
			// testsrc2 draws its colours at 4:2:0 resolution, so they survive the
			// conversion's subsampling: what is left is the conversion's own error.
			const source = ffmpeg.lavfi('testsrc2=size=160x120:rate=10:duration=1', 160, 120)[0];
			const picture = cut(source, width, height);
			const frame = rgbaToI420(picture, width, height);
			const right = difference(readBack(frame, 'bt709', 'limited'), picture);
			// As close as FFmpeg's own conversion comes (limited range has fewer levels than full).
			const own = difference(readBack(ffmpegI420(source, 160, 120), 'bt709', 'limited'), source);
			expect(right).toBeLessThan(own + 0.1);
			// Read with Firefox's RGBA matrix, or as full range: far off.
			expect(difference(readBack(frame, 'bt601', 'limited'), picture)).toBeGreaterThan(right + 2);
			expect(difference(readBack(frame, 'bt709', 'full'), picture)).toBeGreaterThan(right + 1);
		});
	}
});
