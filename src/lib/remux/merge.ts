/**
 * Merge a video-only and an audio-only stream into one file with ffmpeg.wasm —
 * a stream copy (remux), never a re-encode, so it runs at I/O speed. Pure
 * over an injected ffmpeg core and byte handles: the remux worker passes the
 * real core and OPFS handles, the integration test the real core and memory.
 */
import type { MergeContainer } from '$lib/formats';
import { withHandles, type ByteHandle, type EmscriptenFs } from './handle-fs';

/** The slice of `@ffmpeg/core`'s module this uses. */
export interface FFmpegCore {
	FS: EmscriptenFs;
	/** Runs ffmpeg synchronously; returns its exit code. */
	exec(...args: string[]): number;
	/** Clears the exit code and timeout between runs. */
	reset(): void;
	setLogger(logger: (entry: { type: 'stdout' | 'stderr'; message: string }) => void): void;
}

export interface MergeFiles {
	video: ByteHandle;
	audio: ByteHandle;
	/** Truncated, then written. */
	output: ByteHandle;
}

const MUXER: Record<MergeContainer, string> = { mp4: 'mp4', webm: 'webm', mkv: 'matroska' };

/** How many of ffmpeg's last error lines an error message carries. */
const ERROR_LINES = 6;

export function mergeArgs(container: MergeContainer, dir: string): string[] {
	return [
		'-hide_banner',
		'-loglevel',
		'error',
		'-i',
		`${dir}/video`,
		'-i',
		`${dir}/audio`,
		// Exactly one picture and one sound track, whatever else the inputs hold.
		'-map',
		'0:v:0',
		'-map',
		'1:a:0',
		'-c',
		'copy',
		// The index up front, so players can start before the whole file loads.
		...(container === 'mp4' ? ['-movflags', '+faststart'] : []),
		'-f',
		MUXER[container],
		`${dir}/output`
	];
}

let runs = 0;

/**
 * Remux `files.video` + `files.audio` into `files.output`. Returns the output's
 * size; throws with ffmpeg's own error lines when it fails.
 */
export function mergeStreams(
	core: FFmpegCore,
	files: MergeFiles,
	container: MergeContainer
): number {
	const errors: string[] = [];
	core.setLogger(({ type, message }) => {
		// "Aborted()" is how ffmpeg.wasm unwinds after exit(), not an error.
		if (type === 'stderr' && !message.startsWith('Aborted(')) errors.push(message);
	});
	const dir = `/merge-${++runs}`;
	const code = withHandles(core.FS, dir, { ...files }, () => {
		try {
			return core.exec(...mergeArgs(container, dir));
		} finally {
			core.reset();
			core.setLogger(() => {});
		}
	});
	if (code !== 0) {
		const detail = errors.slice(-ERROR_LINES).join('\n').replaceAll(`${dir}/`, '');
		throw new Error(
			`ffmpeg could not merge the streams (exit code ${code})${detail ? `:\n${detail}` : ''}`
		);
	}
	files.output.flush();
	return files.output.getSize();
}
