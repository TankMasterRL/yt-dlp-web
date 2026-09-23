/**
 * The app's one Library, wired to the browser: IndexedDB, OPFS, the download
 * and remux workers, Web Locks and a BroadcastChannel for other tabs.
 * Browser-only — pages call it from their scripts, never from modules that
 * tests import.
 */
import { activeDownloads } from '$lib/download/locks';
import { workerDownloader } from '$lib/download/client';
import { relayFetch } from '$lib/relay/client';
import { workerRemuxer } from '$lib/remux/client';
import { openLibraryDb, type LibraryDb } from './db';
import { Library, type FileStore } from './library.svelte';

let library: Library | undefined;

/** `relay`: the relay endpoint; `assetsBase`: where ffmpeg/ is served, if it is. */
export function getLibrary({
	relay: relayEndpoint,
	assetsBase
}: {
	relay: string;
	assetsBase: string;
}): Library {
	library ??= new Library({
		db: lazyDb(),
		downloader: workerDownloader(relayEndpoint),
		remuxer: workerRemuxer(assetsBase),
		files: opfsFiles,
		activeDownloads: () => activeDownloads(),
		fetchThumbnail: (url) => fetchThumbnail(relayEndpoint, url),
		channel: new BroadcastChannel('yt-dlp-web:library')
	});
	return library;
}

function lazyDb(): LibraryDb {
	let db: Promise<LibraryDb> | undefined;
	const open = () => (db ??= openLibraryDb());
	return {
		all: async () => (await open()).all(),
		get: async (id) => (await open()).get(id),
		put: async (item) => (await open()).put(item),
		delete: async (id) => (await open()).delete(id)
	};
}

const opfsFiles: FileStore = {
	async get(fileName) {
		const root = await navigator.storage.getDirectory();
		return (await root.getFileHandle(fileName)).getFile();
	},
	async remove(fileName) {
		const root = await navigator.storage.getDirectory();
		try {
			await root.removeEntry(fileName);
		} catch (e) {
			if ((e as DOMException).name !== 'NotFoundError') throw e;
		}
	}
};

/** Thumbnails come through the relay too: no image host ever sees the viewer. */
async function fetchThumbnail(relayEndpoint: string, url: string): Promise<Blob | null> {
	const response = await relayFetch(relayEndpoint, { url });
	if (response.status !== 200 || !response.body) {
		await response.body?.cancel();
		return null;
	}
	const type = new Headers(response.headers).get('content-type') ?? '';
	const blob = await new Response(response.body).blob();
	// Only ever store images: the relay serves octet-stream, the real type is tunnelled.
	return type.startsWith('image/') ? new Blob([blob], { type }) : null;
}
