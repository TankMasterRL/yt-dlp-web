/**
 * What the animate worker does: build one GIF, a frame at a time. Kept apart
 * from the worker script so tests can serve the real thing over a
 * MessageChannel.
 */
import type { WorkerHandlers } from '$lib/workers/protocol';
import type { AnimateLoad, AnimateWork } from './client';
import { GifEncoder } from './gif';
import { buildPalette } from './quantize';

export function gifHandlers(): WorkerHandlers<AnimateLoad, AnimateWork, Blob | null, never> {
	let encoder: GifEncoder | null = null;
	return {
		async load() {},
		work(work) {
			switch (work.kind) {
				case 'begin':
					encoder = new GifEncoder({
						width: work.width,
						height: work.height,
						palette: buildPalette(work.samples)
					});
					return null;
				case 'frame':
					if (!encoder) throw new Error('frame before begin');
					encoder.addFrame(work.pixels, work.delay);
					return null;
				case 'finish': {
					if (!encoder) throw new Error('finish before begin');
					const gif = new Blob(encoder.finish(), { type: 'image/gif' });
					encoder = null;
					return gif;
				}
			}
		}
	};
}
