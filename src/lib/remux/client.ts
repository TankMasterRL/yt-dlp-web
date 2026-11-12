/** Main-thread side of the remux worker: the Library's `Remuxer`. */
import remuxWorkerUrl from '../../workers/remux.worker.ts?worker&url';
import type { MergeRequest, Remuxer } from '$lib/storage/library.svelte';
import { trustedWorkerUrl } from '$lib/trusted-types';
import { WorkerClient, type Endpoint } from '$lib/workers/protocol';
import { FFMPEG_CORE_WASM, FFMPEG_DIR } from './assets';

export interface RemuxLoad {
	/** ffmpeg/ lives under it. */
	assetsBase: string;
}

export interface RemuxWork {
	request: MergeRequest;
}

export interface RemuxerDeps {
	spawn?: () => Endpoint & { terminate(): void };
	fetch?: typeof fetch;
}

const spawnWorker = () =>
	new Worker(trustedWorkerUrl(remuxWorkerUrl), { type: 'module', name: 'remux' });

/**
 * One worker, started when a merge is prepared (its parts start downloading)
 * or starts, and stopped once the last of those ends: the core's wasm
 * (~31 MiB for ffmpeg.wasm, ~2.5 MiB for the remux core) and its heap are
 * held only while a merge is under way, and it is loaded by the time the
 * parts are in. A load that fails fails the merges waiting on it; the next
 * one after the worker stops tries afresh.
 */
export function workerRemuxer(
	assetsBase: string,
	{ spawn = spawnWorker, fetch: fetchImpl = fetch }: RemuxerDeps = {}
): Remuxer {
	let client: WorkerClient<RemuxLoad, RemuxWork, { bytesTotal: number }, never> | null = null;
	let running = 0;
	let available: Promise<boolean> | undefined;

	const start = () => {
		const started = new WorkerClient<RemuxLoad, RemuxWork, { bytesTotal: number }, never>(spawn());
		// A failed load rejects the call waiting on it; nothing else to report.
		started.load({ assetsBase }).catch(() => {});
		return started;
	};

	/** Holds the worker until the returned release is called (once; again does nothing). */
	const hold = () => {
		running++;
		const current = (client ??= start());
		let held = true;
		const release = () => {
			if (!held) return;
			held = false;
			if (--running === 0) {
				current.terminate();
				client = null;
			}
		};
		return { current, release };
	};

	return {
		available: () =>
			(available ??= fetchImpl(new URL(FFMPEG_DIR + FFMPEG_CORE_WASM, assetsBase), {
				method: 'HEAD'
			})
				.then((response) => response.ok)
				.catch(() => false)),
		prepare: () => hold().release,
		async merge(request) {
			const { current, release } = hold();
			try {
				return await current.call({ request });
			} finally {
				release();
			}
		}
	};
}
