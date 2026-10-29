/** Main-thread side of the animate worker: the editor's `AnimationEncoder`. */
import animateWorkerUrl from '../../workers/animate.worker.ts?worker&url';
import { trustedWorkerUrl } from '$lib/trusted-types';
import { WorkerClient, type Endpoint } from '$lib/workers/protocol';
import type { Size } from './clip';
import type { AnimationEncoder } from './editor.svelte';

/** Nothing to fetch: the encoder is plain code, bundled with the worker. */
export type AnimateLoad = Record<string, never>;

export type AnimateWork =
	| { kind: 'begin'; width: number; height: number; samples: Uint8ClampedArray[] }
	| { kind: 'frame'; pixels: Uint8ClampedArray; delay: number }
	| { kind: 'finish' };

export interface EncoderDeps {
	spawn?: () => Endpoint & { terminate(): void };
}

const spawnWorker = () =>
	new Worker(trustedWorkerUrl(animateWorkerUrl), { type: 'module', name: 'animate' });

/**
 * One worker per animation, stopped once its GIF is out (or it is closed):
 * the frames in flight and the encoder's tables are held only while used.
 */
export function workerEncoder({ spawn = spawnWorker }: EncoderDeps = {}): AnimationEncoder {
	const client = new WorkerClient<AnimateLoad, AnimateWork, Blob | null, never>(spawn());
	// A failed load rejects the call waiting on it; nothing else to report.
	client.load({}).catch(() => {});
	return {
		async begin({ width, height }: Size, samples) {
			// Copied, not transferred: the editor may send the same pixels again as frames.
			await client.call({ kind: 'begin', width, height, samples });
		},
		async frame(pixels, delay) {
			await client.call({ kind: 'frame', pixels, delay }, [pixels.buffer]);
		},
		async finish() {
			try {
				return (await client.call({ kind: 'finish' }))!;
			} finally {
				client.terminate();
			}
		},
		close() {
			client.terminate(new DOMException('The animation was cancelled', 'AbortError'));
		}
	};
}
