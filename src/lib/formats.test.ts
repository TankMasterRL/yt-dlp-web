import { describe, expect, it } from 'vitest';
import type { FormatInfo, VideoInfo } from '$lib/engine/runtime';
import {
	bestMergePair,
	codecName,
	downloadPlan,
	formatBytes,
	formatDuration,
	formatKind,
	formatsBestFirst,
	isDownloadable,
	primaryVideo,
	resolutionLabel,
	sizeOf
} from './formats';

const f = (partial: Partial<FormatInfo>): FormatInfo => ({
	format_id: 'x',
	url: 'https://x/',
	...partial
});

describe('formatKind', () => {
	it('reads yt-dlp codec conventions', () => {
		expect(formatKind(f({ vcodec: 'avc1.64001F', acodec: 'mp4a.40.2' }))).toBe('av');
		expect(formatKind(f({ vcodec: 'vp9', acodec: 'none' }))).toBe('video');
		expect(formatKind(f({ vcodec: 'none', acodec: 'opus' }))).toBe('audio');
	});
	it('treats unknown codecs (direct links) as a complete file', () => {
		expect(formatKind(f({}))).toBe('av');
	});
});

describe('labels', () => {
	it('describes resolution', () => {
		expect(resolutionLabel(f({ width: 1920, height: 1080 }))).toBe('1080p');
		expect(resolutionLabel(f({ width: 1920, height: 1080, fps: 60 }))).toBe('1080p60');
		expect(resolutionLabel(f({ vcodec: 'none', acodec: 'opus' }))).toBe('audio only');
		expect(resolutionLabel(f({}))).toBe('—');
	});

	it.each([
		[0, '0 B'],
		[1023, '1023 B'],
		[1536, '1.5 KiB'],
		[5 * 1024 * 1024, '5.0 MiB'],
		[3.25 * 1024 ** 3, '3.25 GiB']
	])('formats %i bytes as %s', (n, label) => {
		expect(formatBytes(n)).toBe(label);
	});

	it.each([
		[59, '0:59'],
		[61, '1:01'],
		[3600 + 62, '1:01:02']
	])('formats %i seconds as %s', (s, label) => {
		expect(formatDuration(s)).toBe(label);
	});

	it.each([
		['avc1.64001F', 'H.264'],
		['vp09.00.40.08', 'VP9'],
		['vp9', 'VP9'],
		['vp8', 'VP8'],
		['av01.0.08M.08', 'AV1'],
		['mp4a.40.2', 'AAC'],
		['mp4a.40.34', 'MP3'],
		['opus', 'Opus'],
		['theora', 'theora'],
		['none', null],
		[undefined, null]
	])('names codec %s as %s', (codec, name) => {
		expect(codecName(codec)).toBe(name);
	});

	it('prefers the exact size and marks approximations', () => {
		expect(sizeOf(f({ filesize: 100, filesize_approx: 90 }))).toEqual({
			bytes: 100,
			approx: false
		});
		expect(sizeOf(f({ filesize_approx: 90 }))).toEqual({ bytes: 90, approx: true });
		expect(sizeOf(f({}))).toBeNull();
	});
});

describe('choosing formats', () => {
	it('lists yt-dlp formats best first', () => {
		const formats = [f({ format_id: 'worst' }), f({ format_id: 'mid' }), f({ format_id: 'best' })];
		expect(formatsBestFirst(formats).map((x) => x.format_id)).toEqual(['best', 'mid', 'worst']);
	});

	it('downloads plain HTTP(S) formats; streaming manifests are not supported yet', () => {
		expect(isDownloadable(f({ protocol: 'https' }))).toBe(true);
		expect(isDownloadable(f({ protocol: 'http' }))).toBe(true);
		expect(isDownloadable(f({}))).toBe(true);
		expect(isDownloadable(f({ protocol: 'm3u8_native' }))).toBe(false);
		expect(isDownloadable(f({ protocol: 'http_dash_segments' }))).toBe(false);
	});

	it('finds the video in a playlist-shaped result', () => {
		const video = { id: 'v', title: 'V' } as VideoInfo;
		expect(
			primaryVideo({ id: 'p', title: 'P', _type: 'playlist', entries: [video] } as VideoInfo)
		).toBe(video);
		expect(primaryVideo(video)).toBe(video);
	});

	it('plans a download from the format yt-dlp resolved, headers and chunking included', () => {
		const format = f({
			format_id: '18',
			url: 'https://rr1.googlevideo.com/videoplayback?n=solved',
			ext: 'mp4',
			http_headers: { 'User-Agent': 'UA', Referer: 'https://www.youtube.com/' },
			downloader_options: { http_chunk_size: 10485760 },
			filesize: 1234
		});
		expect(downloadPlan(format)).toEqual({
			formatId: '18',
			url: 'https://rr1.googlevideo.com/videoplayback?n=solved',
			ext: 'mp4',
			headers: [
				['User-Agent', 'UA'],
				['Referer', 'https://www.youtube.com/']
			],
			chunkSize: 10485760,
			expectedBytes: 1234
		});
	});
});

describe('merging split streams', () => {
	const v = (id: string, ext: string, vcodec = 'vp9') =>
		f({ format_id: id, ext, vcodec, acodec: 'none', height: 720 });
	const a = (id: string, ext: string, acodec = 'opus') =>
		f({ format_id: id, ext, vcodec: 'none', acodec });

	it("picks the best video-only and audio-only streams, like yt-dlp's bv*+ba", () => {
		const pair = bestMergePair([
			a('249', 'webm'),
			v('243', 'webm'),
			a('251', 'webm'),
			v('248', 'webm'),
			f({ format_id: '18' })
		]);
		expect(pair).toEqual({
			video: expect.objectContaining({ format_id: '248' }),
			audio: expect.objectContaining({ format_id: '251' }),
			container: 'webm'
		});
	});

	it('prefers audio from the same container family, so no re-encoding is ever needed', () => {
		const pair = bestMergePair([
			a('140', 'm4a', 'mp4a.40.2'),
			a('251', 'webm'),
			v('137', 'mp4', 'avc1.640028')
		]);
		expect(pair?.audio.format_id).toBe('140');
		expect(pair?.container).toBe('mp4');
	});

	it('falls back to Matroska when the families differ', () => {
		expect(bestMergePair([a('251', 'webm'), v('137', 'mp4', 'avc1')])?.container).toBe('mkv');
	});

	it('offers nothing without both halves, or when a half is streaming-only', () => {
		expect(bestMergePair([v('137', 'mp4'), f({ format_id: '18' })])).toBeNull();
		expect(
			bestMergePair([v('137', 'mp4'), { ...a('140', 'm4a'), protocol: 'm3u8_native' }])
		).toBeNull();
	});
});
