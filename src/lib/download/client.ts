/** Main-thread side of the download worker: the Library's `Downloader`. */
import downloadWorkerUrl from '../../workers/download.worker.ts?worker&url';
import type { Downloader, DownloadRequest, ImportRequest } from '$lib/storage/library.svelte';
import { trustedWorkerUrl } from '$lib/trusted-types';
import { WorkerClient } from '$lib/workers/protocol';
import type { DownloadProgress } from './download';

export interface DownloadLoad {
	/** Null in a build without a relay: the worker then only imports. */
	relayEndpoint: string | null;
}

export type DownloadWork =
	| { kind: 'start'; request: DownloadRequest }
	/** The File is posted by reference: the worker reads it from disk, a slice at a time. */
	| { kind: 'import'; request: ImportRequest }
	| { kind: 'cancel'; itemId: string };

export type DownloadWorkerProgress = { itemId: string } & DownloadProgress;

/** One worker for all downloads and imports, started on first use. */
export function workerDownloader(relayEndpoint: string | null): Downloader {
	let client: WorkerClient<
		DownloadLoad,
		DownloadWork,
		{ bytesTotal: number } | null,
		DownloadWorkerProgress
	> | null = null;
	const listeners = new Map<string, (progress: DownloadProgress) => void>();
	const worker = () => {
		if (!client) {
			client = new WorkerClient(
				new Worker(trustedWorkerUrl(downloadWorkerUrl), { type: 'module', name: 'downloads' }),
				({ itemId, ...progress }) => listeners.get(itemId)?.(progress)
			);
			void client.load({ relayEndpoint });
		}
		return client;
	};
	const run = async (
		work: Extract<DownloadWork, { request: unknown }>,
		onProgress: (progress: DownloadProgress) => void
	) => {
		listeners.set(work.request.itemId, onProgress);
		try {
			return (await worker().call(work))!;
		} finally {
			listeners.delete(work.request.itemId);
		}
	};
	return {
		start: (request, onProgress) => run({ kind: 'start', request }, onProgress),
		importFile: (request, onProgress) => run({ kind: 'import', request }, onProgress),
		async cancel(itemId) {
			await worker().call({ kind: 'cancel', itemId });
		}
	};
}
