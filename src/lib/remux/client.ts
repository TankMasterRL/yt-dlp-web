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
 * One worker, started when a merge starts and stopped when the last running
 * merge ends: ffmpeg's ~31 MiB of wasm and its heap are held only while used.
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

	return {
		available: () =>
			(available ??= fetchImpl(new URL(FFMPEG_DIR + FFMPEG_CORE_WASM, assetsBase), {
				method: 'HEAD'
			})
				.then((response) => response.ok)
				.catch(() => false)),
		async merge(request) {
			running++;
			const current = (client ??= start());
			try {
				return await current.call({ request });
			} finally {
				if (--running === 0) {
					current.terminate();
					client = null;
				}
			}
		}
	};
}
