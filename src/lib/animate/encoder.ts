/**
 * What the animate worker does: make one animated image, a frame at a time,
 * in the format asked for. Kept apart from the worker script so tests can
 * serve the real thing over a MessageChannel, or run an encoder in-thread.
 */
import type { WorkerHandlers } from '$lib/workers/protocol';
import { ApngEncoder } from './apng';
import { AvifEncoder, webCodecsAv1 } from './avif';
import { delayAt } from './clip';
import type { AnimateLoad, AnimateWork, EncodeOptions } from './client';
import { FORMATS, type AnimationFormat } from './formats';
import { GifEncoder } from './gif';
import { JxlEncoder } from './jxl';
import { buildPalette } from './quantize';
import { WebpEncoder, canvasWebpEncoder } from './webp';

/** One animation being made. */
export interface FrameEncoder {
	/** Appends the next frame (RGBA, the animation's size), shown for 1/fps s. */
	add(pixels: Uint8ClampedArray): void | Promise<void>;
	finish(): Blob | Promise<Blob>;
}

export type EncoderFactory = (
	options: EncodeOptions,
	samples: Uint8ClampedArray[]
) => FrameEncoder | Promise<FrameEncoder>;

export const ENCODERS: Record<AnimationFormat, EncoderFactory> = {
	gif({ width, height, fps }, samples) {
		const gif = new GifEncoder({ width, height, palette: buildPalette(samples) });
		let index = 0;
		return {
			add: (pixels) => gif.addFrame(pixels, delayAt(index++, fps, 100)),
			finish: () => new Blob(gif.finish(), { type: FORMATS.gif.mime })
		};
	},
	webp({ width, height, fps, quality }) {
		const webp = new WebpEncoder({ width, height, fps, encodeStill: canvasWebpEncoder(quality) });
		return {
			add: (pixels) => webp.addFrame(pixels),
			finish: () => new Blob(webp.finish(), { type: FORMATS.webp.mime })
		};
	},
	apng({ width, height, fps }) {
		const apng = new ApngEncoder({ width, height, fps });
		return {
			add: (pixels) => apng.addFrame(pixels),
			finish: async () => new Blob(await apng.finish(), { type: FORMATS.apng.mime })
		};
	},
	async avif({ width, height, fps, quality }) {
		const av1 = await webCodecsAv1({ width, height, fps, quality });
		if (!av1) throw new Error("This browser can't encode AV1, which AVIF is made of");
		const avif = new AvifEncoder({ width, height, fps, encoder: av1 });
		return {
			add: (pixels) => avif.addFrame(pixels),
			finish: async () => new Blob(await avif.finish(), { type: FORMATS.avif.mime })
		};
	},
	jxl({ width, height, fps }) {
		const jxl = new JxlEncoder({ width, height, fps });
		return {
			add: (pixels) => jxl.addFrame(pixels),
			finish: () => new Blob(jxl.finish(), { type: FORMATS.jxl.mime })
		};
	}
};

export function animateHandlers(
	encoders: Record<AnimationFormat, EncoderFactory> = ENCODERS
): WorkerHandlers<AnimateLoad, AnimateWork, Blob | null, never> {
	let encoder: FrameEncoder | null = null;
	return {
		async load() {},
		async work(work) {
			switch (work.kind) {
				case 'begin':
					encoder = await encoders[work.options.format](work.options, work.samples);
					return null;
				case 'frame':
					if (!encoder) throw new Error('frame before begin');
					await encoder.add(work.pixels);
					return null;
				case 'finish': {
					if (!encoder) throw new Error('finish before begin');
					const file = await encoder.finish();
					encoder = null;
					return file;
				}
			}
		}
	};
}
