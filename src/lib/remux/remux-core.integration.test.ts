// @vitest-environment node
/**
 * The remux core `bun run build:ffmpeg` compiles — FFmpeg with every demuxer,
 * muxer, parser and bitstream filter and no codec at all — run for real on
 * ffmpeg command lines. ffmpeg.wasm, which has encoders, lavfi and ffprobe,
 * makes the inputs no fixture has and inspects every output. Skipped until the
 * core is built; Dockerfile.test builds it, so CI always runs this.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	loadFFmpegCore,
	loadRemuxCore,
	remuxCoreBuilt,
	type NodeCore,
	type NodeFFmpegCore
} from '../../../tests/helpers/ffmpeg';

const fixture = (name: string) =>
	new Uint8Array(readFileSync(new URL(`../../../tests/fixtures/media/${name}`, import.meta.url)));

let core: NodeCore;
let reference: NodeFFmpegCore;

/** Run an ffmpeg command line: the exit code, and what went to stderr. */
function run(target: NodeCore, args: string[]): { code: number; errors: string[] } {
	const errors: string[] = [];
	target.setLogger(({ type, message }) => {
		if (type === 'stderr' && !message.startsWith('Aborted(')) errors.push(message);
	});
	try {
		return { code: target.exec('-hide_banner', '-loglevel', 'error', ...args), errors };
	} finally {
		target.reset();
		target.setLogger(() => {});
	}
}

const encoded = new Map<string, Uint8Array>();
/** A second of test pattern or tone, encoded by ffmpeg.wasm (once per name). */
function encode(name: string, args: string[]): Uint8Array {
	let bytes = encoded.get(name);
	if (!bytes) {
		const { code, errors } = run(reference, [...args, `/${name}`]);
		expect(code, errors.join('\n')).toBe(0);
		bytes = reference.FS.readFile(`/${name}`);
		reference.FS.unlink(`/${name}`);
		encoded.set(name, bytes);
	}
	return bytes;
}
const picture = (...codec: string[]) => [
	...['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1', '-an'],
	...['-pix_fmt', 'yuv420p', '-c:v', ...codec]
];
const tone = (...codec: string[]) => [
	...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-vn', '-c:a'],
	...codec
];

interface Probed {
	streams?: Record<string, string | number | Record<string, string>>[];
	format?: { tags?: Record<string, string> };
	chapters?: { start_time: string; end_time: string; tags?: Record<string, string> }[];
}

/** What ffprobe (ffmpeg.wasm's) reads from a file: `entries` as JSON. */
function probe(bytes: Uint8Array, entries = 'stream=codec_name,codec_type'): Probed {
	reference.FS.writeFile('/probe', bytes);
	const lines: string[] = [];
	reference.setLogger(({ type, message }) => {
		if (type === 'stdout') lines.push(message);
	});
	reference.ffprobe('-v', 'error', '-show_entries', entries, '-of', 'json', '/probe');
	reference.reset();
	reference.setLogger(() => {});
	reference.FS.unlink('/probe');
	return JSON.parse(lines.join('\n') || '{}') as Probed;
}

/** Each stream as 'codec,type', e.g. 'h264,video'. */
const streamsOf = (bytes: Uint8Array) =>
	(probe(bytes).streams ?? []).map((st) => `${st.codec_name},${st.codec_type}`);

/** Remux files (name → bytes) with the remux core: the output's bytes, or its errors thrown. */
function remux(files: Record<string, Uint8Array>, args: string[]): Uint8Array {
	for (const [name, bytes] of Object.entries(files)) core.FS.writeFile(`/${name}`, bytes);
	try {
		const { code, errors } = run(core, [...args, '/out']);
		if (code !== 0) throw new Error(errors.join('\n') || `exit code ${code}`);
		return core.FS.readFile('/out');
	} finally {
		for (const name of [...Object.keys(files), 'out']) {
			if (core.FS.readdir('/').includes(name)) core.FS.unlink(`/${name}`);
		}
	}
}

const ascii = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

// Inputs, as their codec and container.
const VIDEO = {
	'H.264 in MP4': () => encode('h264.mp4', picture('libx264')),
	'H.264 in MPEG-TS': () => encode('h264.ts', [...picture('libx264'), '-f', 'mpegts']),
	'H.264 in FLV': () => encode('h264.flv', picture('libx264')),
	// Recorded by Chromium: ffmpeg.wasm has no AV1 encoder, and its VP9 encoder crashes.
	'AV1 in fragmented MP4': () => fixture('bbf-av1.mp4'),
	'VP9 in WebM': () => fixture('bbf-vp9.webm'),
	'VP8 in WebM': () => fixture('bbf-360.webm'),
	'MPEG-4 Part 2 in AVI': () => encode('mpeg4.avi', picture('mpeg4')),
	'MPEG-2 in MPEG-PS': () => encode('mpeg2.mpg', [...picture('mpeg2video'), '-f', 'mpeg']),
	'Theora in Ogg': () => encode('theora.ogv', picture('libtheora'))
};
const AUDIO = {
	'AAC in M4A': () => encode('aac.m4a', tone('aac')),
	'AAC in ADTS': () => encode('aac.aac', [...tone('aac'), '-f', 'adts']),
	'Opus in WebM': () => fixture('bbf-audio.webm'),
	'Opus in Ogg': () => encode('opus.ogg', [...tone('libopus'), '-ar', '48000', '-f', 'ogg']),
	'Vorbis in Ogg': () => encode('vorbis.ogg', [...tone('libvorbis'), '-f', 'ogg']),
	MP3: () => encode('tone.mp3', tone('libmp3lame')),
	FLAC: () => encode('tone.flac', tone('flac')),
	'AC-3': () => encode('tone.ac3', tone('ac3')),
	'E-AC-3 in Matroska': () => encode('eac3.mka', [...tone('eac3'), '-f', 'matroska']),
	'PCM in WAV': () => encode('tone.wav', tone('pcm_s16le'))
};

/** [video, audio, the muxer, the streams ffprobe then sees]. */
const MERGES: [keyof typeof VIDEO, keyof typeof AUDIO, string, string[]][] = [
	// YouTube's best formats, into the containers the app writes.
	['H.264 in MP4', 'AAC in M4A', 'mp4', ['h264,video', 'aac,audio']],
	['AV1 in fragmented MP4', 'AAC in M4A', 'mp4', ['av1,video', 'aac,audio']],
	['VP9 in WebM', 'Opus in WebM', 'webm', ['vp9,video', 'opus,audio']],
	['AV1 in fragmented MP4', 'Opus in WebM', 'webm', ['av1,video', 'opus,audio']],
	['VP9 in WebM', 'AAC in M4A', 'matroska', ['vp9,video', 'aac,audio']],
	// Bitstreams that change shape between containers: Annex B H.264 and ADTS AAC
	// into MP4, and back, through bitstream filters — and ADTS's parameters,
	// which only its frame headers carry.
	['H.264 in MPEG-TS', 'AAC in ADTS', 'mp4', ['h264,video', 'aac,audio']],
	['H.264 in MP4', 'AAC in ADTS', 'matroska', ['h264,video', 'aac,audio']],
	['H.264 in MP4', 'AC-3', 'mpegts', ['h264,video', 'ac3,audio']],
	['H.264 in FLV', 'MP3', 'mov', ['h264,video', 'mp3,audio']],
	['VP9 in WebM', 'Opus in Ogg', 'mp4', ['vp9,video', 'opus,audio']],
	['AV1 in fragmented MP4', 'FLAC', 'matroska', ['av1,video', 'flac,audio']],
	// Older and rarer codecs and containers.
	['MPEG-4 Part 2 in AVI', 'MP3', 'avi', ['mpeg4,video', 'mp3,audio']],
	['MPEG-2 in MPEG-PS', 'AC-3', 'mpegts', ['mpeg2video,video', 'ac3,audio']],
	['Theora in Ogg', 'Vorbis in Ogg', 'ogg', ['theora,video', 'vorbis,audio']],
	['VP8 in WebM', 'Vorbis in Ogg', 'webm', ['vp8,video', 'vorbis,audio']],
	['H.264 in MP4', 'E-AC-3 in Matroska', 'mp4', ['h264,video', 'eac3,audio']],
	['H.264 in MP4', 'PCM in WAV', 'mov', ['h264,video', 'pcm_s16le,audio']],
	['VP8 in WebM', 'PCM in WAV', 'nut', ['vp8,video', 'pcm_s16le,audio']]
];

describe.skipIf(!remuxCoreBuilt())('the remux core', () => {
	beforeAll(async () => {
		[core, reference] = await Promise.all([loadRemuxCore(), loadFFmpegCore()]);
	});

	describe('copies any codec between containers', () => {
		it.each(MERGES)('%s + %s → %s', (video, audio, muxer, streams) => {
			const output = remux({ v: VIDEO[video](), a: AUDIO[audio]() }, [
				...['-i', '/v', '-i', '/a', '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy'],
				...['-f', muxer]
			]);
			expect(streamsOf(output)).toEqual(streams);
			// Picture and sound start together (each input from its own zero, as
			// ffmpeg does), and last as long as they did: nothing dropped.
			const [shown, heard] = probe(output, 'stream=start_time,duration').streams!;
			expect(Math.abs(Number(shown.start_time) - Number(heard.start_time))).toBeLessThan(0.05);
			for (const { duration } of [shown, heard])
				if (duration !== undefined) expect(Number(duration)).toBeGreaterThan(0.8);
		});

		it('moves the MP4 index to the front with -movflags +faststart', () => {
			const output = remux({ v: fixture('bbf-av1.mp4'), a: AUDIO['AAC in M4A']() }, [
				...['-i', '/v', '-i', '/a', '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy'],
				...['-movflags', '+faststart', '-f', 'mp4']
			]);
			expect(ascii(output).indexOf('moov')).toBeLessThan(ascii(output).indexOf('mdat'));
		});

		it('writes the codec tag -tag asks for', () => {
			const output = remux({ v: VIDEO['H.264 in MP4']() }, [
				...['-i', '/v', '-c', 'copy', '-tag:v', 'avc3', '-f', 'mp4']
			]);
			expect(probe(output, 'stream=codec_tag_string').streams).toEqual([
				{ codec_tag_string: 'avc3' }
			]);
		});
	});

	describe('reads command lines as ffmpeg does', () => {
		/** 320x240 H.264 with mono AAC, for choices between streams. */
		const both = () =>
			encode('both.mkv', [
				...['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1'],
				...['-f', 'lavfi', '-i', 'sine=duration=1'],
				...['-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-ac', '1']
			]);

		it('without -map, takes the video with the most pixels and the audio with the most channels', () => {
			const output = remux(
				{
					small: VIDEO['H.264 in MP4'](),
					both: both(),
					stereo: encode('stereo.m4a', tone('aac', '-ac', '2'))
				},
				['-i', '/small', '-i', '/both', '-i', '/stereo', '-c', 'copy', '-f', 'matroska']
			);
			expect(probe(output, 'stream=codec_type,width,channels').streams).toEqual([
				{ codec_type: 'video', width: 320 },
				{ codec_type: 'audio', channels: 2 }
			]);
		});

		it('removes what a negative map matches, and skips an optional map that matches nothing', () => {
			const output = remux({ both: both() }, [
				...['-i', '/both', '-map', '0', '-map', '-0:a', '-map', '0:s?', '-c', 'copy'],
				...['-f', 'matroska']
			]);
			expect(streamsOf(output)).toEqual(['h264,video']);
			expect(() =>
				remux({ both: both() }, ['-i', '/both', '-map', '0:s', '-c', 'copy', '-f', 'matroska'])
			).toThrow("Stream map '0:s' matches no streams.");
		});

		it('copies the first input’s metadata and chapters', () => {
			reference.FS.writeFile(
				'/chapters.txt',
				new TextEncoder().encode(
					';FFMETADATA1\ntitle=Two parts\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=500\ntitle=One\n'
				)
			);
			const chaptered = encode('chaptered.mkv', [
				...['-i', '/chapters.txt', ...picture('libx264'), '-map_metadata', '0'],
				'-map_chapters',
				'0'
			]);
			reference.FS.unlink('/chapters.txt');
			const output = remux({ v: chaptered, a: AUDIO['AAC in M4A']() }, [
				...['-i', '/v', '-i', '/a', '-c', 'copy', '-f', 'mp4']
			]);
			expect(probe(output, 'format_tags=title').format?.tags).toEqual({ title: 'Two parts' });
			expect(probe(output, 'chapter=start_time,end_time:chapter_tags=title').chapters).toEqual([
				{ start_time: '0.000000', end_time: '0.500000', tags: { title: 'One' } }
			]);
		});

		it('passes other options to the muxer, and refuses one nothing takes', () => {
			const args = ['-i', '/v', '-c', 'copy'];
			expect(() =>
				remux({ v: VIDEO['H.264 in MP4']() }, [...args, '-brand', 'isom', '-f', 'mp4'])
			).not.toThrow();
			expect(() =>
				remux({ v: VIDEO['H.264 in MP4']() }, [...args, '-bogus', '1', '-f', 'mp4'])
			).toThrow('Option bogus not found.');
		});

		it('never encodes: refuses an encoder, a stream no -c copy covers, or no -c at all', () => {
			const files = { v: VIDEO['H.264 in MP4'](), a: AUDIO['AAC in M4A']() };
			const inputs = ['-i', '/v', '-i', '/a'];
			expect(() => remux(files, [...inputs, '-c:v', 'libx264', '-f', 'mp4'])).toThrow(
				"Cannot encode with 'libx264'"
			);
			expect(() => remux(files, [...inputs, '-c:v', 'copy', '-f', 'mp4'])).toThrow(
				'Output stream #1 (audio) would need an encoder'
			);
			expect(() => remux(files, [...inputs, '-f', 'mp4'])).toThrow('-c copy is required');
		});

		it('says why it cannot choose a muxer', () => {
			const files = { v: VIDEO['H.264 in MP4']() };
			expect(() => remux(files, ['-i', '/v', '-c', 'copy', '-f', 'nope'])).toThrow(
				"Requested output format 'nope' is not known"
			);
			expect(() => remux(files, ['-i', '/v', '-c', 'copy'])).toThrow(
				'Unable to choose an output format'
			);
		});

		it('prints nothing with -loglevel quiet, and still fails', () => {
			core.FS.writeFile('/garbage', new Uint8Array(4096).fill(7));
			const { code, errors } = run(core, [
				'-loglevel',
				'quiet',
				'-i',
				'/garbage',
				'-c',
				'copy',
				'/out'
			]);
			core.FS.unlink('/garbage');
			expect(code).toBe(1);
			expect(errors).toEqual([]);
		});
	});
});
