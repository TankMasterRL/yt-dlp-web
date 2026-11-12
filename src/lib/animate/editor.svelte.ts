/**
 * The animated image editor: which stretch of a video, which part of its
 * picture, how many frames a second, how wide and in which format — and the
 * making of the file from those choices. Reactive state for the dialog; the
 * frames and the encoder are injected (the dialog's <video> and the animate
 * worker; tests pass fakes).
 */
import {
	DEFAULT_FPS,
	DEFAULT_SPAN,
	MAX_FRAMES,
	PALETTE_SAMPLES,
	defaultRange,
	evenRates,
	frameCount,
	frameTimes,
	fullFrame,
	outputSize,
	sampleIndices,
	suggestedFps,
	type Rect,
	type TimeRange
} from './clip';
import type { EncodeOptions } from './client';
import { DEFAULT_QUALITY, FORMATS, type AnimationFormat } from './formats';
import type { FrameSource, VideoMetadata } from './frames';

/** Encodes frames into an animated image (the animate worker, in the app). */
export interface AnimationEncoder {
	/**
	 * Starts an animation. `samples` (RGBA frames spread over it) are for
	 * formats whose colors come from a palette, and empty for the others.
	 */
	begin(options: EncodeOptions, samples: Uint8ClampedArray[]): Promise<void>;
	/** Appends the next frame. Its pixels are handed over. */
	frame(pixels: Uint8ClampedArray): Promise<void>;
	finish(): Promise<Blob>;
	/** Stops at any point: calls still waiting fail with an AbortError. */
	close(): void;
}

export type SpawnEncoder = () => AnimationEncoder;

export interface Animation {
	format: AnimationFormat;
	blob: Blob;
	width: number;
	height: number;
	frames: number;
	/** Seconds. */
	duration: number;
	/** The range it was made from, whatever the editor shows now. */
	range: TimeRange;
}

export const DEFAULT_WIDTH = 480;

export class AnimationEditor {
	/** The video's size and length; null until its metadata is in. */
	media = $state<VideoMetadata | null>(null);
	/** The video's own frame rate, when the browser has shown enough of it to tell. */
	sourceFps = $state<number | null>(null);
	range = $state<TimeRange>({ start: 0, end: DEFAULT_SPAN });
	crop = $state<Rect>({ x: 0, y: 0, width: 0, height: 0 });
	fps = $state(DEFAULT_FPS);
	width = $state(DEFAULT_WIDTH);
	format = $state<AnimationFormat>('gif');
	/** For lossy formats. */
	quality = $state(DEFAULT_QUALITY);
	rendering = $state(false);
	/** Frames taken so far, while rendering. */
	progress = $state<{ done: number; total: number } | null>(null);
	result = $state<Animation | null>(null);
	error = $state<string | null>(null);

	readonly frameCount = $derived(frameCount(this.range, this.fps));
	readonly size = $derived(outputSize(this.crop, this.width));
	readonly tooLong = $derived(this.frameCount > MAX_FRAMES);
	/** Whether every frame steps the same number of the video's pictures (or nobody knows). */
	readonly even = $derived(this.sourceFps === null || evenRates(this.sourceFps).includes(this.fps));

	#spawn: SpawnEncoder;
	#controller: AbortController | null = null;
	#encoder: AnimationEncoder | null = null;

	constructor(spawn: SpawnEncoder) {
		this.#spawn = spawn;
	}

	/** A video to work on: the first seconds of all of its picture, at a rate that suits its own. */
	setMedia(media: VideoMetadata, sourceFps: number | null = null): void {
		this.media = media;
		this.sourceFps = sourceFps;
		this.fps = suggestedFps(sourceFps);
		this.range = defaultRange(media.duration);
		this.crop = fullFrame(media);
		this.result = null;
		this.error = null;
	}

	/**
	 * Makes the animation from frames out of `source`. A GIF's palette comes
	 * from frames spread across the range, taken first; those are kept and sent
	 * again in their turn, so no frame is taken twice. One frame is in the
	 * encoder while the next is taken.
	 */
	async render(source: FrameSource): Promise<void> {
		if (this.rendering || !this.media || this.tooLong) return;
		const range = { ...this.range };
		const crop = { ...this.crop };
		const size = { ...this.size };
		const { format, fps, quality } = this;
		const times = frameTimes(range, fps);
		const controller = new AbortController();
		const encoder = this.#spawn();
		this.#controller = controller;
		this.#encoder = encoder;
		this.result = null;
		this.error = null;
		this.rendering = true;
		this.progress = { done: 0, total: times.length };

		const take = async (i: number) => {
			const pixels = await source.frameAt(times[i], crop, size, controller.signal);
			this.progress!.done++;
			return pixels;
		};
		try {
			await source.prepare?.(range, controller.signal);
			const samples = new Map<number, Uint8ClampedArray>();
			if (FORMATS[format].palette) {
				for (const i of sampleIndices(times.length, PALETTE_SAMPLES)) {
					samples.set(i, await take(i));
				}
			}
			await encoder.begin({ format, ...size, fps, quality }, [...samples.values()]);
			let pending: Promise<void> = Promise.resolve();
			for (let i = 0; i < times.length; i++) {
				const pixels = samples.get(i) ?? (await take(i));
				samples.delete(i);
				await pending;
				pending = encoder.frame(pixels);
				// Awaited in turn; until then, a failure is not "unhandled".
				pending.catch(() => {});
			}
			await pending;
			const blob = await encoder.finish();
			this.result = {
				format,
				blob,
				...size,
				frames: times.length,
				duration: times.length / fps,
				range
			};
		} catch (e) {
			if ((e as Error).name !== 'AbortError') this.error = (e as Error).message;
		} finally {
			encoder.close();
			if (this.#encoder === encoder) {
				this.#encoder = null;
				this.#controller = null;
			}
			this.rendering = false;
			this.progress = null;
		}
	}

	/** Stops a render under way; it ends with neither a result nor an error. */
	cancel(): void {
		this.#controller?.abort(new DOMException('The animation was cancelled', 'AbortError'));
		this.#encoder?.close();
	}
}
