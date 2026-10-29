// @vitest-environment node
/**
 * The GIF encoder checked by a decoder that is not ours: the REAL ffmpeg.wasm
 * (`@ffmpeg/core`) decodes every GIF the encoder writes, frame by frame, and
 * ffprobe reads its timing. ffmpeg.wasm also renders the moving test picture
 * that stands in for a video.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadFFmpegCore, type NodeFFmpegCore } from '../../../tests/helpers/ffmpeg';
import { GifEncoder } from './gif';
import { buildPalette } from './quantize';

let ffmpeg: NodeFFmpegCore;
beforeAll(async () => {
	ffmpeg = await loadFFmpegCore();
});

function run(args: string[]): void {
	const errors: string[] = [];
	ffmpeg.setLogger(({ type, message }) => {
		if (type === 'stderr' && !message.startsWith('Aborted(')) errors.push(message);
	});
	try {
		expect(ffmpeg.exec('-hide_banner', '-loglevel', 'error', ...args), errors.join('\n')).toBe(0);
	} finally {
		ffmpeg.reset();
		ffmpeg.setLogger(() => {});
	}
}

/** Raw RGBA frames out of ffmpeg, split one per frame. */
function rawFrames(args: string[], width: number, height: number): Uint8ClampedArray[] {
	run([...args, '-pix_fmt', 'rgba', '-fps_mode', 'passthrough', '-f', 'rawvideo', '/frames']);
	const bytes = ffmpeg.FS.readFile('/frames');
	ffmpeg.FS.unlink('/frames');
	const size = width * height * 4;
	expect(bytes.length % size).toBe(0);
	return Array.from(
		{ length: bytes.length / size },
		(_, i) => new Uint8ClampedArray(bytes.slice(i * size, (i + 1) * size))
	);
}

/** One second of an ffmpeg test source, as RGBA frames. */
function lavfi(source: string, width: number, height: number): Uint8ClampedArray[] {
	const frames = rawFrames(['-f', 'lavfi', '-i', source], width, height);
	expect(frames).toHaveLength(10);
	return frames;
}

/** What ffmpeg's GIF decoder shows, frame by frame. */
function decodeWithFFmpeg(gif: Uint8Array, width: number, height: number) {
	ffmpeg.FS.writeFile('/in.gif', gif);
	try {
		return rawFrames(['-i', '/in.gif'], width, height);
	} finally {
		ffmpeg.FS.unlink('/in.gif');
	}
}

/** ffprobe's frame durations, in seconds. */
function durations(gif: Uint8Array): number[] {
	ffmpeg.FS.writeFile('/probe.gif', gif);
	const lines: string[] = [];
	ffmpeg.setLogger(({ type, message }) => {
		if (type === 'stdout') lines.push(message);
	});
	ffmpeg.ffprobe(
		'-v',
		'error',
		'-show_entries',
		'packet=duration_time',
		'-of',
		'csv=p=0',
		'/probe.gif'
	);
	ffmpeg.reset();
	ffmpeg.setLogger(() => {});
	ffmpeg.FS.unlink('/probe.gif');
	return lines.filter(Boolean).map(Number);
}

function encode(
	width: number,
	height: number,
	frames: Uint8ClampedArray[],
	delay: number,
	palette = buildPalette(frames.slice(0, 16))
): Uint8Array {
	const encoder = new GifEncoder({ width, height, palette });
	for (const frame of frames) encoder.addFrame(frame, delay);
	const chunks = encoder.finish();
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	chunks.reduce((at, chunk) => (out.set(chunk, at), at + chunk.length), 0);
	return out;
}

/** Bytes that differ (a count, not a diff: vitest's diff of whole frames takes minutes). */
function mismatches(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
	let n = Math.abs(a.length - b.length);
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
	return n;
}

/** Peak signal-to-noise ratio over RGB, in dB. */
function psnr(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
	let sum = 0;
	let n = 0;
	for (let i = 0; i < a.length; i += 4) {
		for (let c = 0; c < 3; c++) {
			sum += (a[i + c] - b[i + c]) ** 2;
			n++;
		}
	}
	return 10 * Math.log10((255 * 255) / (sum / n));
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
		const shown = decodeWithFFmpeg(gif, width, height);
		expect(shown).toHaveLength(frames.length);
		expect(shown.map((frame, i) => mismatches(frame, frames[i]))).toEqual([0, 0, 0, 0, 0, 0]);
		expect(durations(gif)).toEqual([0.08, 0.08, 0.08, 0.08, 0.08, 0.08]);
	});

	it('shows every shade of a picture exactly, when they fit in a palette', () => {
		const [width, height] = [16, 15];
		// 240 colors, neighbours a single level apart.
		const shades = new Uint8ClampedArray(width * height * 4);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) shades.set([100 + x, 100 + y, 100, 255], (y * width + x) * 4);
		}
		expect(buildPalette([shades]).exact).toBe(true);
		const [shown] = decodeWithFFmpeg(encode(width, height, [shades], 10), width, height);
		expect(mismatches(shown, shades)).toBe(0);
	});

	it('stays close to a moving picture of far more colors than a GIF holds', () => {
		const [width, height] = [160, 120];
		const source = lavfi(`testsrc2=size=${width}x${height}:rate=10:duration=1`, width, height);
		const palette = buildPalette(source);
		expect(palette.exact).toBe(false);
		const gif = encode(width, height, source, 10, palette);
		const shown = decodeWithFFmpeg(gif, width, height);
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
