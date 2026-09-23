import { describe, expect, it } from 'vitest';
import type { FormatInfo, VideoInfo } from '$lib/engine/runtime';
import {
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
