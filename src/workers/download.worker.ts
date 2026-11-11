/**
 * The download worker: media bytes into OPFS — through the relay, or copied
 * from a file picked on this device (an import).
 *
 * Each download or import holds a Web Lock named for its item, so other tabs
 * can tell a running one from one orphaned by a closed tab, and never start a
 * second writer for the same file. Bytes are written with an OPFS sync access
 * handle, which only exists in dedicated workers.
 */
import { copyToSink } from '$lib/download/copy';
import { downloadToSink, type ByteSink, type DownloadProgress } from '$lib/download/download';
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
/** Null in a build without a relay: then only imports can be written. */
let relayEndpoint: string | null = null;
const running = new Map<string, AbortController>();

function sinkFor(handle: SyncAccessHandle): ByteSink {
	return {
		size: () => handle.getSize(),
		write(bytes, at) {
			const written = handle.write(bytes, { at });
			if (written !== bytes.byteLength)
				throw new Error(`short write: ${written} of ${bytes.byteLength} bytes`);
		},
		truncate: (size) => handle.truncate(size),
		flush: () => handle.flush()
	};
}

/**
 * Run `write` on the item's file under the item's Web Lock, with a sink over
 * an OPFS sync access handle and an AbortController `cancel` reaches.
 */
function withSink(
	itemId: string,
	fileName: string,
	write: (sink: ByteSink, signal: AbortSignal) => Promise<{ bytesTotal: number }>
): Promise<{ bytesTotal: number }> {
	return navigator.locks.request(downloadLockName(itemId), { ifAvailable: true }, async (lock) => {
		if (!lock) throw new Error('This item is already downloading in another tab');
		const controller = new AbortController();
		running.set(itemId, controller);
		try {
			const root = await navigator.storage.getDirectory();
			const file = await root.getFileHandle(fileName, { create: true });
			const handle = (await (
				file as unknown as { createSyncAccessHandle(): Promise<SyncAccessHandle> }
			).createSyncAccessHandle()) as SyncAccessHandle;
			try {
				return await write(sinkFor(handle), controller.signal);
			} finally {
				handle.close();
			}
		} finally {
			running.delete(itemId);
		}
	});
}

/** Progress for the item, at most every PROGRESS_INTERVAL_MS (and always the last). */
function throttled(
	itemId: string,
	progress: (p: DownloadWorkerProgress) => void
): (p: DownloadProgress) => void {
	let last = 0;
	return (p) => {
		const now = performance.now();
		if (now - last < PROGRESS_INTERVAL_MS && p.bytesDone !== p.bytesTotal) return;
		last = now;
		progress({ itemId, ...p });
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
		if (work.kind === 'import') {
			const { itemId, fileName, file } = work.request;
			return withSink(itemId, fileName, (sink, signal) =>
				copyToSink(file, sink, { signal, onProgress: throttled(itemId, progress) })
			);
		}
		const { itemId, fileName, plan } = work.request;
		const relay = relayEndpoint;
		if (!relay) throw new Error('This deployment has no relay, so nothing can be downloaded');
		return withSink(itemId, fileName, (sink, signal) =>
			downloadToSink(plan, sink, (request) => relayFetch(relay, { ...request, signal }), {
				signal,
				onProgress: throttled(itemId, progress)
			})
		);
	}
});
