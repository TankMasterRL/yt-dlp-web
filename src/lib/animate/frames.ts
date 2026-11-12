/**
 * Frames out of a video file the browser decodes itself: seek a <video> to a
 * time, draw the crop onto a canvas at the output size, read the pixels.
 * Media elements exist only on the main thread, so this runs in the page;
 * the encoding happens in the animate worker. Whatever the browser can play,
 * it can make an animation from — no demuxer or decoder of our own.
 *
 * Each frame is the picture on screen at its time, taken by seeking to the
 * middle of that picture on the video's frame grid (grid.ts), which a moment
 * of playback measures first: seeks to the times themselves land on the
 * edges between pictures, and come out doubled or lost.
 */
import type { Rect, Size, TimeRange } from './clip';
import { fitGrid, frameIndex, frameMiddle, gridReach, type FrameGrid } from './grid';

export interface FrameSource {
	/** Gets ready to take frames from `range` (learns where the video's pictures start). */
	prepare?(range: TimeRange, signal?: AbortSignal): Promise<void>;
	/** The picture at `time` seconds: `crop` scaled to `size`, as RGBA pixels. */
	frameAt(time: number, crop: Rect, size: Size, signal?: AbortSignal): Promise<Uint8ClampedArray>;
}

/** What a picture shown says of itself (requestVideoFrameCallback's metadata). */
export interface ShownPicture {
	/** When it starts, while playing; after a seek, Firefox and WebKit say the time sought. */
	mediaTime: number;
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
	requestVideoFrameCallback?(callback: (now: number, picture: ShownPicture) => void): number;
	cancelVideoFrameCallback?(handle: number): void;
	/** For a moment of playback, to learn when pictures start (videos the page plays are muted). */
	playbackRate?: number;
	play?(): Promise<void>;
	pause?(): void;
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

/** A <video> of the page's own over a file, for taking pictures: nobody watches it. */
export interface OpenedVideo {
	video: SeekableVideo & CanvasImageSource;
	/** Lets go of the file: the element stops reading it, and its blob: URL is revoked. */
	close(): void;
}

/** One transparent pixel, fixed to the viewport's corner: on screen, whatever scrolls, and unseen. */
const UNSEEN = {
	position: 'fixed',
	left: '0',
	top: '0',
	width: '1px',
	height: '1px',
	opacity: '0',
	'pointer-events': 'none'
};

/**
 * A muted <video> over a blob: URL of `file` (CSP media-src blob:), in the
 * page but never seen, until closed. In the page because WebKit draws a
 * video on a canvas only while it is in the page and on screen: detached,
 * or off screen, it draws nothing — a black still, a blank frame timeline.
 * Its styles go through the CSSOM, which CSP's style-src-attr does not govern.
 */
export function openVideo(file: Blob): OpenedVideo {
	const video = document.createElement('video');
	video.muted = true;
	video.playsInline = true;
	video.preload = 'auto';
	video.setAttribute('aria-hidden', 'true');
	for (const [property, value] of Object.entries(UNSEEN)) video.style.setProperty(property, value);
	const url = URL.createObjectURL(file);
	video.src = url;
	document.body.append(video);
	return {
		video,
		close() {
			video.remove();
			video.removeAttribute('src');
			video.load();
			URL.revokeObjectURL(url);
		}
	};
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

/**
 * The media's size (0 × 0 for sound only) and length, waiting for its
 * metadata if need be; `signal` gives up on a file the browser never answers
 * about.
 */
export async function mediaMetadata(
	video: SeekableVideo,
	signal?: AbortSignal
): Promise<VideoMetadata> {
	if (video.readyState < HAVE_METADATA) await until(video, 'loadedmetadata', signal);
	if (!Number.isFinite(video.duration)) {
		// Some files (live recordings, MediaRecorder's WebM) state no length: the
		// browser learns it by seeking to the end.
		await seek(video, Number.MAX_SAFE_INTEGER, signal);
		await seek(video, 0, signal);
	}
	const { videoWidth: width, videoHeight: height, duration } = video;
	return { width, height, duration };
}

/** The video's size and length, waiting for its metadata if need be. */
export async function videoMetadata(video: SeekableVideo): Promise<VideoMetadata> {
	const { width, height, duration } = await mediaMetadata(video);
	if (!width || !height) throw new Error('This file has no picture to make an animation from');
	if (!Number.isFinite(duration) || duration <= 0)
		throw new Error("Couldn't tell how long this video is");
	return { width, height, duration };
}

/** Pictures noted at once while playing: five intervals, enough to number the ones further on. */
const FIRST_LOOK = 6;
/** Pictures noted further on, to refine the grid over a longer range. */
const FURTHER_LOOK = 3;
/** Played at half speed, so even a 120 fps video shows every picture on a 60 Hz screen. */
const LOOK_RATE = 0.5;
/** Gives up on a video that shows no pictures playing (one off screen, or a slideshow). */
const LOOK_TIMEOUT_MS = 3000;
/** Times this close are the same time: starts reported twice, or the picture already shown. */
const SAME_TIME = 0.00025;

/**
 * When the next `count` pictures after `time` start, as the browser reports
 * them while the video plays (every engine does then; after a seek Firefox
 * and WebKit report the time sought). Fewer if the video ends, or shows none
 * in time; none if it will not play or report.
 */
async function pictureStarts(
	video: SeekableVideo,
	time: number,
	count: number,
	signal?: AbortSignal
): Promise<number[]> {
	const { requestVideoFrameCallback: request, play, pause } = video;
	if (!request || !play || !pause) return [];
	await seek(video, time, signal);
	signal?.throwIfAborted();
	const starts: number[] = [];
	const rate = video.playbackRate;
	let handle = 0;
	let stop = () => {};
	const stopped = new Promise<void>((resolve) => (stop = resolve));
	const shown = (_now: number, picture?: ShownPicture) => {
		const start = picture?.mediaTime;
		// The picture shown when playing began is reported at the time sought, not where it starts.
		if (
			start !== undefined &&
			start > time + SAME_TIME &&
			starts.every((s) => Math.abs(s - start) > SAME_TIME)
		)
			starts.push(start);
		if (starts.length >= count) stop();
		else handle = request.call(video, shown);
	};
	const aborted = () => stop();
	const timer = setTimeout(stop, LOOK_TIMEOUT_MS);
	video.addEventListener('ended', stop);
	video.addEventListener('error', stop);
	signal?.addEventListener('abort', aborted);
	try {
		handle = request.call(video, shown);
		if (rate !== undefined) video.playbackRate = LOOK_RATE;
		await Promise.race([play.call(video), stopped]);
		await stopped;
	} catch {
		// It would not play: no starts to learn from.
	} finally {
		clearTimeout(timer);
		video.removeEventListener('ended', stop);
		video.removeEventListener('error', stop);
		signal?.removeEventListener('abort', aborted);
		video.cancelVideoFrameCallback?.(handle);
		pause.call(video);
		if (rate !== undefined) video.playbackRate = rate;
	}
	signal?.throwIfAborted();
	return starts;
}

/**
 * The video's frame grid over `range`, from moments of it playing: at the
 * start, then further on as often as the range needs to keep it good to 2 ms
 * to the end (`gridReach`). Null when the browser reports no pictures, or they
 * keep no steady rate (a variable-rate recording): then frames are taken at
 * their own times.
 */
export async function learnGrid(
	video: SeekableVideo,
	range: TimeRange,
	signal?: AbortSignal
): Promise<FrameGrid | null> {
	let starts = await pictureStarts(video, range.start, FIRST_LOOK, signal);
	let grid = fitGrid(starts);
	while (grid) {
		const reach = gridReach(grid);
		if (frameIndex(grid, range.end) <= reach) break;
		const further = await pictureStarts(video, frameMiddle(grid, reach), FURTHER_LOOK, signal);
		const refined = fitGrid([...starts, ...further], grid);
		// Nothing further (the video ended): this is as far as it can be learned.
		if (refined && refined.span <= grid.span) break;
		starts = [...starts, ...further];
		grid = refined;
	}
	return grid;
}

export function videoFrames(
	video: SeekableVideo & CanvasImageSource,
	canvas: FrameCanvas = document.createElement('canvas')
): FrameSource {
	const context = canvas.getContext('2d', { willReadFrequently: true });
	if (!context) throw new Error('This browser gives the page no 2D canvas');
	let grid: FrameGrid | null = null;
	return {
		async prepare(range, signal) {
			grid = await learnGrid(video, range, signal);
		},
		async frameAt(time, crop, size, signal) {
			await seek(video, grid ? frameMiddle(grid, frameIndex(grid, time)) : time, signal);
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
