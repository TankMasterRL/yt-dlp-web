/**
 * The download worker: media bytes through the relay into OPFS.
 *
 * Each download holds a Web Lock named for its item, so other tabs can tell a
 * running download from one orphaned by a closed tab, and never start a second
 * writer for the same file. Bytes are written with an OPFS sync access handle,
 * which only exists in dedicated workers.
 */
import { downloadToSink, type ByteSink } from '$lib/download/download';
import type { DownloadLoad, DownloadWork, DownloadWorkerProgress } from '$lib/download/client';
import { downloadLockName } from '$lib/download/locks';
import { relayFetch } from '$lib/relay/client';
import { serveWorker } from '$lib/workers/protocol';

/** The OPFS sync access handle, which TypeScript's DOM lib does not describe. */
interface SyncAccessHandle {
	getSize(): number;
	write(buffer: Uint8Array, options: { at: number }): number;
	truncate(size: number): void;
	flush(): void;
	close(): void;
}

const PROGRESS_INTERVAL_MS = 200;
let relayEndpoint = '';
const running = new Map<string, AbortController>();

function sinkFor(handle: SyncAccessHandle): ByteSink {
	return {
		size: () => handle.getSize(),
		write(bytes, at) {
			const written = handle.write(bytes, { at });
			if (written !== bytes.byteLength) throw new Error(`short write: ${written} of ${bytes.byteLength} bytes`);
		},
		truncate: (size) => handle.truncate(size),
		flush: () => handle.flush()
	};
}

serveWorker<DownloadLoad, DownloadWork, { bytesTotal: number } | null, DownloadWorkerProgress>({
	async load(load) {
		relayEndpoint = load.relayEndpoint;
	},
	async work(work, progress) {
		if (work.kind === 'cancel') {
			running.get(work.itemId)?.abort();
			return null;
		}
		const { itemId, fileName, plan } = work.request;
		return navigator.locks.request(downloadLockName(itemId), { ifAvailable: true }, async (lock) => {
			if (!lock) throw new Error('This item is already downloading in another tab');
			const controller = new AbortController();
			running.set(itemId, controller);
			const root = await navigator.storage.getDirectory();
			const file = await root.getFileHandle(fileName, { create: true });
			const handle = (await (
				file as unknown as { createSyncAccessHandle(): Promise<SyncAccessHandle> }
			).createSyncAccessHandle()) as SyncAccessHandle;
			let last = 0;
			try {
				return await downloadToSink(
					plan,
					sinkFor(handle),
					(request) => relayFetch(relayEndpoint, { ...request, signal: controller.signal }),
					{
						signal: controller.signal,
						onProgress: (p) => {
							const now = performance.now();
							if (now - last < PROGRESS_INTERVAL_MS && p.bytesDone !== p.bytesTotal) return;
							last = now;
							progress({ itemId, ...p });
						}
					}
				);
			} finally {
				handle.close();
				running.delete(itemId);
			}
		});
	}
});
