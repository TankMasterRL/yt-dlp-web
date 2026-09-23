/** Presentation and download-planning helpers for yt-dlp's format dicts. */
import type { FormatInfo, VideoInfo } from '$lib/engine/runtime';
import type { HeaderList } from '$lib/relay/protocol';

/** av = one file with picture and sound; video/audio = one half of a split stream. */
export type FormatKind = 'av' | 'video' | 'audio';

/** yt-dlp marks a missing stream with codec 'none'; an absent codec means unknown. */
export function formatKind(format: FormatInfo): FormatKind {
	if (format.vcodec === 'none' && format.acodec !== 'none') return 'audio';
	if (format.acodec === 'none' && format.vcodec !== 'none') return 'video';
	return 'av';
}

export function resolutionLabel(format: FormatInfo): string {
	if (formatKind(format) === 'audio') return 'audio only';
	if (!format.height) return '—';
	return `${format.height}p${format.fps && format.fps > 30 ? Math.round(format.fps) : ''}`;
}

const CODEC_NAMES: [RegExp, string][] = [
	[/^(avc|h264)/, 'H.264'],
	[/^(hvc|hev|h265)/, 'H.265'],
	[/^vp0?9/, 'VP9'],
	[/^vp0?8/, 'VP8'],
	[/^av0?1/, 'AV1'],
	[/^(mp3|mp4a\.(6b|69|40\.34))/, 'MP3'],
	[/^mp4a/, 'AAC'],
	[/^opus/, 'Opus'],
	[/^vorbis/, 'Vorbis'],
	[/^flac/, 'FLAC']
];

/** A codec as people know it: 'avc1.64001F' → 'H.264'. */
export function codecName(codec: string | undefined): string | null {
	if (!codec || codec === 'none') return null;
	const lower = codec.toLowerCase();
	return CODEC_NAMES.find(([pattern]) => pattern.test(lower))?.[1] ?? codec.split('.')[0];
}

export function sizeOf(format: FormatInfo): { bytes: number; approx: boolean } | null {
	if (format.filesize) return { bytes: format.filesize, approx: false };
	if (format.filesize_approx) return { bytes: format.filesize_approx, approx: true };
	return null;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KiB', 'MiB', 'GiB', 'TiB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(unit >= 2 ? 2 : 1).replace(/(\.\d)0$/, '$1')} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
	const s = Math.round(seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const rest = String(s % 60).padStart(2, '0');
	return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

/** yt-dlp orders formats worst → best; people want the opposite. */
export function formatsBestFirst(formats: readonly FormatInfo[]): FormatInfo[] {
	return [...formats].reverse();
}

/**
 * Plain HTTP(S) formats download in the browser today. Segmented streaming
 * protocols (HLS, DASH segments) need a fragment downloader and are listed but
 * not offered.
 */
export function isDownloadable(format: FormatInfo): boolean {
	return !format.protocol || format.protocol === 'https' || format.protocol === 'http';
}

/** With noplaylist, yt-dlp still wraps some results (e.g. HTML5 pages) in a playlist. */
export function primaryVideo(info: VideoInfo): VideoInfo {
	return info.entries?.[0] ?? info;
}

/** Everything the download worker needs, straight from the format yt-dlp resolved. */
export interface DownloadPlan {
	formatId: string;
	url: string;
	ext: string;
	/** yt-dlp's per-format headers (User-Agent, Referer, …): the server may insist on them. */
	headers: HeaderList;
	/** Fetch in ranges of this size (YouTube throttles large single requests). */
	chunkSize: number | null;
	expectedBytes: number | null;
}

export function downloadPlan(format: FormatInfo): DownloadPlan {
	return {
		formatId: format.format_id,
		url: format.url,
		ext: format.ext ?? 'bin',
		headers: Object.entries(format.http_headers ?? {}),
		chunkSize: format.downloader_options?.http_chunk_size ?? null,
		expectedBytes: sizeOf(format)?.bytes ?? null
	};
}

/** Containers the remux worker writes; all hold both streams without re-encoding. */
export type MergeContainer = 'mp4' | 'webm' | 'mkv';

export interface MergePair {
	video: FormatInfo;
	audio: FormatInfo;
	container: MergeContainer;
}

function containerFamily(ext: string | undefined): 'mp4' | 'webm' | 'other' {
	if (ext === 'mp4' || ext === 'm4a' || ext === 'm4v' || ext === 'mov') return 'mp4';
	if (ext === 'webm') return 'webm';
	return 'other';
}

/**
 * yt-dlp's `bv*+ba`, in the browser: the best video-only and audio-only
 * downloadable streams (yt-dlp lists formats worst → best), preferring audio
 * from the video's container family so the pair stays in MP4 or WebM;
 * mixed families go to Matroska, which holds anything. Streams are copied,
 * never re-encoded.
 */
export function bestMergePair(formats: readonly FormatInfo[]): MergePair | null {
	const downloadable = formats.filter(isDownloadable);
	const video = downloadable.filter((f) => formatKind(f) === 'video').at(-1);
	const audios = downloadable.filter((f) => formatKind(f) === 'audio');
	if (!video || !audios.length) return null;
	const family = containerFamily(video.ext);
	const audio = audios.findLast((a) => containerFamily(a.ext) === family) ?? audios.at(-1)!;
	const container: MergeContainer =
		family !== 'other' && containerFamily(audio.ext) === family ? family : 'mkv';
	return { video, audio, container };
}
