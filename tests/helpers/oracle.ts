/**
 * The REAL ffmpeg.wasm as an oracle for the animation encoders: it decodes
 * what they write with decoders that are not ours, renders test pictures to
 * stand in for video, and probes containers. Shared by the integration tests.
 */
import { expect } from 'vitest';
import type { NodeFFmpegCore } from './ffmpeg';

export function oracle(ffmpeg: NodeFFmpegCore) {
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

	/** Runs `use` with `bytes` as a file in ffmpeg's memory, removed afterwards. */
	function withFile<T>(name: string, bytes: Uint8Array, use: (path: string) => T): T {
		const path = `/${name}`;
		ffmpeg.FS.writeFile(path, bytes);
		try {
			return use(path);
		} finally {
			ffmpeg.FS.unlink(path);
		}
	}

	return {
		run,
		rawFrames,
		withFile,
		/** One second of an ffmpeg test source at 10 fps, as RGBA frames. */
		lavfi(source: string, width: number, height: number): Uint8ClampedArray[] {
			const frames = rawFrames(['-f', 'lavfi', '-i', source], width, height);
			expect(frames).toHaveLength(10);
			return frames;
		},
		/** What ffmpeg's decoder shows, frame by frame (`ext` picks the demuxer). */
		decode(bytes: Uint8Array, ext: string, width: number, height: number): Uint8ClampedArray[] {
			return withFile(`in.${ext}`, bytes, (path) => rawFrames(['-i', path], width, height));
		},
		/** ffprobe's `entries` (e.g. 'packet=duration_time'), one CSV line each. */
		probe(bytes: Uint8Array, ext: string, entries: string): string[] {
			return withFile(`probe.${ext}`, bytes, (path) => {
				const lines: string[] = [];
				ffmpeg.setLogger(({ type, message }) => {
					if (type === 'stdout') lines.push(message);
				});
				ffmpeg.ffprobe('-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', path);
				ffmpeg.reset();
				ffmpeg.setLogger(() => {});
				return lines.filter(Boolean);
			});
		}
	};
}

/** Bytes that differ (a count, not a diff: vitest's diff of whole frames takes minutes). */
export function mismatches(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
	let n = Math.abs(a.length - b.length);
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
	return n;
}

/** Peak signal-to-noise ratio over RGB, in dB. */
export function psnr(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
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

/** Chunks of bytes as one array. */
export function concat(chunks: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	chunks.reduce((at, chunk) => (out.set(chunk, at), at + chunk.length), 0);
	return out;
}
