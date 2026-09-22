/**
 * Library metadata in IndexedDB. The media bytes live in OPFS (one file per
 * item, `fileName`); this store holds what the library shows and what a paused
 * download needs to resume.
 */
import type { DownloadPlan, FormatKind } from '$lib/formats';

export type ItemStatus = 'downloading' | 'paused' | 'complete' | 'failed';

export interface LibraryItem {
	id: string;
	/** The page yt-dlp extracted from. */
	sourceUrl: string;
	videoId: string;
	extractor: string;
	title: string;
	uploader?: string;
	duration?: number;
	formatId: string;
	ext: string;
	kind: FormatKind;
	resolution: string;
	/** OPFS file holding the bytes. */
	fileName: string;
	bytesTotal: number | null;
	bytesDone: number;
	status: ItemStatus;
	error?: string;
	createdAt: number;
	completedAt?: number;
	/** Fetched through the relay, so no image host ever sees the viewer. */
	thumbnail?: Blob;
	/** What the download worker needs to (re)start. */
	plan: DownloadPlan;
}

export interface LibraryDb {
	all(): Promise<LibraryItem[]>;
	get(id: string): Promise<LibraryItem | undefined>;
	put(item: LibraryItem): Promise<void>;
	delete(id: string): Promise<void>;
}

const DB_NAME = 'yt-dlp-web';
const STORE = 'items';

export async function openLibraryDb(factory: IDBFactory = indexedDB): Promise<LibraryDb> {
	const db = await request(
		(() => {
			const open = factory.open(DB_NAME, 1);
			open.onupgradeneeded = () => {
				const store = open.result.createObjectStore(STORE, { keyPath: 'id' });
				store.createIndex('createdAt', 'createdAt');
			};
			return open;
		})()
	);
	const tx = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);
	return {
		async all() {
			const items = await request<LibraryItem[]>(tx('readonly').index('createdAt').getAll());
			return items.reverse();
		},
		get: (id) => request<LibraryItem | undefined>(tx('readonly').get(id)),
		put: async (item) => {
			await request(tx('readwrite').put(item));
		},
		delete: async (id) => {
			await request(tx('readwrite').delete(id));
		}
	};
}

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}
