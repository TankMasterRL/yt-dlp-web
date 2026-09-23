// @vitest-environment node
/**
 * Runs the REAL ffmpeg.wasm core the app serves (`@ffmpeg/core`), with its I/O
 * going through the handle filesystem the remux worker mounts over OPFS —
 * here over in-memory handles with the same semantics.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadFFmpegCore, MemoryHandle, type NodeFFmpegCore } from '../../../tests/helpers/ffmpeg';
import { withHandles } from './handle-fs';
import { mergeArgs, mergeStreams } from './merge';

const fixture = (name: string) =>
	new Uint8Array(readFileSync(new URL(`../../../tests/fixtures/media/${name}`, import.meta.url)));
const VIDEO_WEBM = fixture('bbf-360.webm'); // VP8, no audio
const AUDIO_WEBM = fixture('bbf-audio.webm'); // Opus, no video

let core: NodeFFmpegCore;
beforeAll(async () => {
	core = await loadFFmpegCore();
});

/** Encode a file with ffmpeg itself (in memory), for inputs no fixture has. */
function synthesize(name: string, args: string[]): Uint8Array {
	const path = `/${name}`;
	expect(core.exec('-hide_banner', '-loglevel', 'error', ...args, path)).toBe(0);
	core.reset();
	const bytes = core.FS.readFile(path);
	core.FS.unlink(path);
	return bytes;
}

/** ffprobe's view of a file's streams, e.g. ['vp8,video', 'opus,audio']. */
function streams(bytes: Uint8Array): string[] {
	core.FS.writeFile('/probe', bytes);
	const lines: string[] = [];
	core.setLogger(({ type, message }) => {
		if (type === 'stdout') lines.push(message);
	});
	core.ffprobe(
		'-v',
		'error',
		'-show_entries',
		'stream=codec_name,codec_type',
		'-of',
		'csv=p=0',
		'/probe'
	);
	core.reset();
	core.FS.unlink('/probe');
	return lines;
}

const ascii = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

describe('mergeStreams (real ffmpeg.wasm)', () => {
	it('remuxes a video-only and an audio-only WebM into one WebM holding both', () => {
		const output = new MemoryHandle();
		const size = mergeStreams(
			core,
			{ video: new MemoryHandle(VIDEO_WEBM), audio: new MemoryHandle(AUDIO_WEBM), output },
			'webm'
		);
		expect(size).toBe(output.getSize());
		expect(size).toBeGreaterThan(VIDEO_WEBM.byteLength);
		expect(streams(output.bytes)).toEqual(['vp8,video', 'opus,audio']);
		expect(ascii(output.bytes.subarray(0, 64))).toContain('webm'); // EBML DocType
		expect(output.flushes).toBeGreaterThan(0);
	});

	it('writes MP4 with the index up front (faststart), rereading its own output through the handle', () => {
		const video = synthesize('v.mp4', [
			'-f',
			'lavfi',
			'-i',
			'testsrc=size=160x120:rate=10:duration=1',
			'-c:v',
			'libx264',
			'-pix_fmt',
			'yuv420p',
			'-an'
		]);
		const audio = synthesize('a.m4a', [
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440:duration=1',
			'-c:a',
			'aac',
			'-vn'
		]);
		// Plain ffmpeg output puts the index (moov) after the media (mdat)…
		expect(ascii(video).indexOf('moov')).toBeGreaterThan(ascii(video).indexOf('mdat'));

		const output = new MemoryHandle();
		mergeStreams(
			core,
			{ video: new MemoryHandle(video), audio: new MemoryHandle(audio), output },
			'mp4'
		);
		const merged = ascii(output.bytes);
		// …the merge moves it to the front, which means reading the output back.
		expect(merged.indexOf('moov')).toBeGreaterThan(-1);
		expect(merged.indexOf('moov')).toBeLessThan(merged.indexOf('mdat'));
		expect(streams(output.bytes)).toEqual(['h264,video', 'aac,audio']);
	});

	it('puts streams from different container families into Matroska', () => {
		const audio = synthesize('a.m4a', [
			'-f',
			'lavfi',
			'-i',
			'sine=duration=1',
			'-c:a',
			'aac',
			'-vn'
		]);
		const output = new MemoryHandle();
		mergeStreams(
			core,
			{ video: new MemoryHandle(VIDEO_WEBM), audio: new MemoryHandle(audio), output },
			'mkv'
		);
		expect(streams(output.bytes)).toEqual(['vp8,video', 'aac,audio']);
		expect(ascii(output.bytes.subarray(0, 64))).toContain('matroska');
	});

	it('replaces whatever an earlier attempt left in the output', () => {
		const output = new MemoryHandle(new Uint8Array(1 << 20).fill(0xff));
		const size = mergeStreams(
			core,
			{ video: new MemoryHandle(VIDEO_WEBM), audio: new MemoryHandle(AUDIO_WEBM), output },
			'webm'
		);
		expect(size).toBeLessThan(1 << 20);
		expect(streams(output.bytes)).toEqual(['vp8,video', 'opus,audio']);
	});

	it("fails with ffmpeg's own reason, leaves nothing mounted, and the core stays usable", () => {
		const garbage = new MemoryHandle(new Uint8Array(4096).fill(7));
		expect(() =>
			mergeStreams(
				core,
				{ video: new MemoryHandle(VIDEO_WEBM), audio: garbage, output: new MemoryHandle() },
				'webm'
			)
		).toThrow(/exit code 1\):\naudio: Invalid data found when processing input/);
		expect(core.FS.readdir('/').filter((name) => name.startsWith('merge-'))).toEqual([]);

		const output = new MemoryHandle();
		mergeStreams(
			core,
			{ video: new MemoryHandle(VIDEO_WEBM), audio: new MemoryHandle(AUDIO_WEBM), output },
			'webm'
		);
		expect(streams(output.bytes)).toEqual(['vp8,video', 'opus,audio']);
	});

	it('fails when the "video" has no picture to take', () => {
		expect(() =>
			mergeStreams(
				core,
				{
					video: new MemoryHandle(AUDIO_WEBM),
					audio: new MemoryHandle(AUDIO_WEBM),
					output: new MemoryHandle()
				},
				'webm'
			)
		).toThrow(/matches no streams/);
	});
});

describe('the handle filesystem', () => {
	it('exposes exactly the files it was given: nothing can be created, renamed or deleted', () => {
		const file = new MemoryHandle(new Uint8Array([1, 2, 3]));
		withHandles(core.FS, '/fence', { file }, () => {
			expect(core.FS.readdir('/fence').sort()).toEqual(['.', '..', 'file']);
			expect(core.FS.readFile('/fence/file')).toEqual(new Uint8Array([1, 2, 3]));
			core.FS.writeFile('/fence/file', new Uint8Array([9]));
			expect(file.bytes).toEqual(new Uint8Array([9]));
			expect(() => core.FS.writeFile('/fence/other', new Uint8Array([1]))).toThrow();
			expect(() => core.FS.unlink('/fence/file')).toThrow();
		});
		expect(core.FS.readdir('/')).not.toContain('fence');
	});

	it('unmounts even when the work throws', () => {
		expect(() =>
			withHandles(core.FS, '/boom', { file: new MemoryHandle() }, () => {
				throw new Error('boom');
			})
		).toThrow('boom');
		expect(core.FS.readdir('/')).not.toContain('boom');
	});

	it('refuses file names that are paths', () => {
		expect(() =>
			withHandles(core.FS, '/bad', { '../escape': new MemoryHandle() }, () => {})
		).toThrow();
		expect(core.FS.readdir('/')).not.toContain('bad');
	});
});

describe('mergeArgs', () => {
	it('copies one video and one audio stream, never re-encoding', () => {
		expect(mergeArgs('webm', '/m')).toEqual([
			'-hide_banner',
			'-loglevel',
			'error',
			'-i',
			'/m/video',
			'-i',
			'/m/audio',
			'-map',
			'0:v:0',
			'-map',
			'1:a:0',
			'-c',
			'copy',
			'-f',
			'webm',
			'/m/output'
		]);
		expect(mergeArgs('mp4', '/m')).toContain('+faststart');
		expect(mergeArgs('mkv', '/m')).toContain('matroska');
	});
});
