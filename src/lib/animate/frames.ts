/**
 * Frames out of a video file the browser decodes itself: seek a <video> to a
 * time, draw the crop onto a canvas at the output size, read the pixels.
 * Media elements exist only on the main thread, so this runs in the page;
 * the encoding happens in the animate worker. Whatever the browser can play,
 * it can make an animation from — no demuxer or decoder of our own.
 */
import type { Rect, Size } from './clip';

export interface FrameSource {
	/** The picture at `time` seconds: `crop` scaled to `size`, as RGBA pixels. */
	frameAt(time: number, crop: Rect, size: Size, signal?: AbortSignal): Promise<Uint8ClampedArray>;
}

/** What this needs of an HTMLVideoElement. */
export interface SeekableVideo extends EventTarget {
	currentTime: number;
	readonly seeking: boolean;
	readonly readyState: number;
	readonly error: { code: number; message: string } | null;
	readonly duration: number;
	readonly videoWidth: number;
	readonly videoHeight: number;
	/** Calls back once the next picture is on screen (HTMLVideoElement.requestVideoFrameCallback). */
	requestVideoFrameCallback?(callback: () => void): number;
}

/** What this needs of a canvas and its 2D context. */
export interface FrameCanvas {
	width: number;
	height: number;
	getContext(
		type: '2d',
		options: { willReadFrequently: boolean }
	): {
		imageSmoothingEnabled: boolean;
		imageSmoothingQuality: ImageSmoothingQuality;
		drawImage(
			image: CanvasImageSource,
			sx: number,
			sy: number,
			sw: number,
			sh: number,
			dx: number,
			dy: number,
			dw: number,
			dh: number
		): void;
		getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray };
	} | null;
}

export interface VideoMetadata {
	width: number;
	height: number;
	duration: number;
}

const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;

const MEDIA_ERRORS: Record<number, string> = {
	1: 'Loading the video was stopped',
	2: 'The video could not be read',
	3: 'The browser could not decode this video',
	4: "This browser can't play this video's format"
};

function mediaError(video: SeekableVideo): Error {
	const { code = 0, message = '' } = video.error ?? {};
	return new Error(MEDIA_ERRORS[code] ?? (message || 'The video failed'));
}

/** Waits for `event`; rejects if the video fails or `signal` aborts first. */
function until(video: SeekableVideo, event: string, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const settle = (outcome: () => void) => () => {
			video.removeEventListener(event, done);
			video.removeEventListener('error', failed);
			signal?.removeEventListener('abort', aborted);
			outcome();
		};
		const done = settle(resolve);
		const failed = settle(() => reject(mediaError(video)));
		const aborted = settle(() => reject(signal!.reason));
		video.addEventListener(event, done);
		video.addEventListener('error', failed);
		signal?.addEventListener('abort', aborted);
	});
}

/** How long to wait, after `seeked`, for the new picture to reach the screen. */
const PRESENT_TIMEOUT_MS = 1000;

/**
 * Shows the frame at `time`: resolves once it is on screen, which is what a
 * canvas draws. `seeked` alone is not enough — Chromium can fire it a few
 * milliseconds before the new picture replaces the old one, and a frame taken
 * then is the previous one. So where the browser reports pictures as they
 * are shown (requestVideoFrameCallback), seek waits for that too; for at most
 * `presentTimeout` ms after `seeked`, in case none is ever shown (a video
 * off screen).
 */
export async function seek(
	video: SeekableVideo,
	time: number,
	signal?: AbortSignal,
	presentTimeout = PRESENT_TIMEOUT_MS
): Promise<void> {
	signal?.throwIfAborted();
	// A seek to where the video already is may never report back.
	if (video.currentTime === time && !video.seeking && video.readyState >= HAVE_CURRENT_DATA) return;
	// Asked before seeking: the video is paused, so the next picture shown is the one sought.
	const shown = video.requestVideoFrameCallback
		? new Promise<void>((resolve) => video.requestVideoFrameCallback!(() => resolve()))
		: null;
	const seeked = until(video, 'seeked', signal);
	video.currentTime = time;
	await seeked;
	if (shown) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			shown,
			new Promise((resolve) => (timer = setTimeout(resolve, presentTimeout)))
		]);
		clearTimeout(timer);
		signal?.throwIfAborted();
	}
}

/** The video's size and length, waiting for its metadata if need be. */
export async function videoMetadata(video: SeekableVideo): Promise<VideoMetadata> {
	if (video.readyState < HAVE_METADATA) await until(video, 'loadedmetadata');
	if (!Number.isFinite(video.duration)) {
		// Some files (live recordings, MediaRecorder's WebM) state no length: the
		// browser learns it by seeking to the end.
		await seek(video, Number.MAX_SAFE_INTEGER);
		await seek(video, 0);
	}
	const { videoWidth: width, videoHeight: height, duration } = video;
	if (!width || !height) throw new Error('This file has no picture to make an animation from');
	if (!Number.isFinite(duration) || duration <= 0)
		throw new Error("Couldn't tell how long this video is");
	return { width, height, duration };
}

export function videoFrames(
	video: SeekableVideo & CanvasImageSource,
	canvas: FrameCanvas = document.createElement('canvas')
): FrameSource {
	const context = canvas.getContext('2d', { willReadFrequently: true });
	if (!context) throw new Error('This browser gives the page no 2D canvas');
	return {
		async frameAt(time, crop, size, signal) {
			await seek(video, time, signal);
			if (canvas.width !== size.width || canvas.height !== size.height) {
				canvas.width = size.width;
				canvas.height = size.height;
			}
			// Resizing a canvas resets its context's state.
			context.imageSmoothingEnabled = true;
			context.imageSmoothingQuality = 'high';
			context.drawImage(
				video,
				crop.x,
				crop.y,
				crop.width,
				crop.height,
				0,
				0,
				size.width,
				size.height
			);
			return context.getImageData(0, 0, size.width, size.height).data;
		}
	};
}
