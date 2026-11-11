/**
 * Open a media file picked on this device the way playback will — in a media
 * element, with the browser's own demuxers and decoders — before it is
 * imported: what it cannot play is refused before anything is stored. Also
 * reads its length and size, and takes a still for the library's thumbnail.
 */
import { mediaMetadata, seek, type SeekableVideo } from '$lib/animate/frames';
import type { MediaFacts } from './imported';

/** Thumbnails are shown at most 8rem wide; twice that covers high-density screens. */
export const THUMBNAIL_WIDTH = 320;
/** The still is taken this far in (a first frame is often black), and never later than 10 s. */
const STILL_AT = 0.1;
const STILL_LATEST_S = 10;
/** How long a browser may take to open a file before it is given up on. */
export const INSPECT_TIMEOUT_MS = 30_000;

/** What this needs of a canvas. */
export interface StillCanvas {
	width: number;
	height: number;
	getContext(type: '2d'): {
		drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
	} | null;
	toBlob(callback: BlobCallback, type: string, quality: number): void;
}

/** Facts of the media `video` is loading: its length and size, and a still of the picture. */
export async function inspectMedia(
	video: SeekableVideo & CanvasImageSource,
	canvas: StillCanvas,
	signal?: AbortSignal
): Promise<MediaFacts> {
	const { width, height, duration } = await mediaMetadata(video, signal);
	const picture = width > 0 && height > 0;
	// A thumbnail is a nicety: without one the library shows a placeholder.
	const thumbnail = picture
		? await still(video, canvas, { width, height, duration }, signal).catch(() => null)
		: null;
	return { width, height, duration, thumbnail };
}

async function still(
	video: SeekableVideo & CanvasImageSource,
	canvas: StillCanvas,
	{ width, height, duration }: { width: number; height: number; duration: number },
	signal?: AbortSignal
): Promise<Blob | null> {
	const at = Number.isFinite(duration) ? Math.min(duration * STILL_AT, STILL_LATEST_S) : 0;
	await seek(video, at, signal);
	canvas.width = Math.min(THUMBNAIL_WIDTH, width);
	canvas.height = Math.max(1, Math.round((height * canvas.width) / width));
	const context = canvas.getContext('2d');
	if (!context) return null;
	context.drawImage(video, 0, 0, canvas.width, canvas.height);
	return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

/** The browser's wiring: a detached, muted <video> over a blob: URL of the file. */
export async function inspectFile(file: File): Promise<MediaFacts> {
	const video = document.createElement('video');
	video.muted = true;
	video.playsInline = true;
	video.preload = 'auto';
	const url = URL.createObjectURL(file);
	video.src = url;
	try {
		return await inspectMedia(
			video,
			document.createElement('canvas'),
			AbortSignal.timeout(INSPECT_TIMEOUT_MS)
		);
	} catch (e) {
		if ((e as Error).name === 'TimeoutError')
			throw new Error(`The browser didn't open it in ${INSPECT_TIMEOUT_MS / 1000} s`);
		throw e;
	} finally {
		// Let go of the file: no element keeps reading it once this is done.
		video.removeAttribute('src');
		video.load();
		URL.revokeObjectURL(url);
	}
}
