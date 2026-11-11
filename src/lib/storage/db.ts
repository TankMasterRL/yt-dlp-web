/**
 * Library metadata in IndexedDB. The media bytes live in OPFS (one file per
 * item, `fileName`) — downloaded through the relay, or imported from a file on
 * this device; this store holds what the library shows and what a paused
 * download needs to resume.
 */
import type { DownloadPlan, FormatKind } from '$lib/formats';

export type ItemStatus = 'downloading' | 'merging' | 'importing' | 'paused' | 'complete' | 'failed';

/** One half of a merged download, stored as its own OPFS file until remuxed. */
export interface MergePart {
	role: 'video' | 'audio';
	formatId: string;
	fileName: string;
	plan: DownloadPlan;
}

/** What every item has, however its bytes got here. */
interface ItemBase {
	id: string;
	title: string;
	uploader?: string;
	duration?: number;
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
	/** Fetched through the relay (no image host ever sees the viewer), or taken from an imported video. */
	thumbnail?: Blob;
}

/** Fetched by yt-dlp through the relay. Records from before imports existed have no `origin`. */
export interface DownloadedItem extends ItemBase {
	origin?: 'download';
	/** The page yt-dlp extracted from. */
	sourceUrl: string;
	videoId: string;
	extractor: string;
	formatId: string;
	/** What the download worker needs to (re)start. For merged items: the video part. */
	plan: DownloadPlan;
	/** Present when the item is two streams remuxed into one file. */
	parts?: MergePart[];
}

/** A media file from this device, copied into the library: nothing was fetched. */
export interface ImportedItem extends ItemBase {
	origin: 'import';
	/** The file's name on the device, as it was picked. */
	originalName: string;
	formatId?: never;
	parts?: never;
}

export type LibraryItem = DownloadedItem | ImportedItem;

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
