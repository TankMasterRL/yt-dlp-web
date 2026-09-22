/** Main-thread side of the download worker: the Library's `Downloader`. */
import downloadWorkerUrl from '../../workers/download.worker.ts?worker&url';
import type { Downloader, DownloadRequest } from '$lib/storage/library.svelte';
import { trustedWorkerUrl } from '$lib/trusted-types';
import { WorkerClient } from '$lib/workers/protocol';
import type { DownloadProgress } from './download';

export interface DownloadLoad {
	relayEndpoint: string;
}

export type DownloadWork = { kind: 'start'; request: DownloadRequest } | { kind: 'cancel'; itemId: string };

export type DownloadWorkerProgress = { itemId: string } & DownloadProgress;

/** One worker for all downloads, started on first use. */
export function workerDownloader(relayEndpoint: string): Downloader {
	let client: WorkerClient<DownloadLoad, DownloadWork, { bytesTotal: number } | null, DownloadWorkerProgress> | null =
		null;
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
	return {
		async start(request, onProgress) {
			listeners.set(request.itemId, onProgress);
			try {
				return (await worker().call({ kind: 'start', request }))!;
			} finally {
				listeners.delete(request.itemId);
			}
		},
		async cancel(itemId) {
			await worker().call({ kind: 'cancel', itemId });
		}
	};
}
