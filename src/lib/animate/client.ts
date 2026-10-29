/** Main-thread side of the animate worker: the editor's `AnimationEncoder`. */
import animateWorkerUrl from '../../workers/animate.worker.ts?worker&url';
import { trustedWorkerUrl } from '$lib/trusted-types';
import { WorkerClient, type Endpoint } from '$lib/workers/protocol';
import type { AnimationEncoder } from './editor.svelte';
import type { AnimationFormat } from './formats';

/** Nothing to fetch: the encoders are plain code, bundled with the worker. */
export type AnimateLoad = Record<string, never>;

/** What an animation is made as. Frames come every 1/fps s; each encoder keeps its own time. */
export interface EncodeOptions {
	format: AnimationFormat;
	width: number;
	height: number;
	fps: number;
	/** 1 to 100, for lossy formats. */
	quality: number;
}

export type AnimateWork =
	| { kind: 'begin'; options: EncodeOptions; samples: Uint8ClampedArray[] }
	| { kind: 'frame'; pixels: Uint8ClampedArray }
	| { kind: 'finish' };

export interface EncoderDeps {
	spawn?: () => Endpoint & { terminate(): void };
}

const spawnWorker = () =>
	new Worker(trustedWorkerUrl(animateWorkerUrl), { type: 'module', name: 'animate' });

/**
 * One worker per animation, stopped once its file is out (or it is closed):
 * the frames in flight and the encoder's tables are held only while used.
 */
export function workerEncoder({ spawn = spawnWorker }: EncoderDeps = {}): AnimationEncoder {
	const client = new WorkerClient<AnimateLoad, AnimateWork, Blob | null, never>(spawn());
	// A failed load rejects the call waiting on it; nothing else to report.
	client.load({}).catch(() => {});
	return {
		async begin(options, samples) {
			// Copied, not transferred: the editor may send the same pixels again as frames.
			await client.call({ kind: 'begin', options, samples });
		},
		async frame(pixels) {
			await client.call({ kind: 'frame', pixels }, [pixels.buffer]);
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
