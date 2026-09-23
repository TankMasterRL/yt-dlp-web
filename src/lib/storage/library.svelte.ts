/**
 * The download library: what has been (or is being) downloaded, as reactive
 * state. Bytes go to OPFS through the download worker; metadata to IndexedDB.
 * Every I/O dependency is injected (`getLibrary()` wires the browser ones).
 */
import type { FormatInfo, VideoInfo } from '$lib/engine/runtime';
import type { DownloadProgress } from '$lib/download/download';
import {
	downloadPlan,
	formatKind,
	primaryVideo,
	resolutionLabel,
	type DownloadPlan
} from '$lib/formats';
import type { LibraryDb, LibraryItem } from './db';

export interface DownloadRequest {
	itemId: string;
	fileName: string;
	plan: DownloadPlan;
}

export interface Downloader {
	/** Resolves when the file is complete; rejects with an AbortError when cancelled. */
	start(
		request: DownloadRequest,
		onProgress: (progress: DownloadProgress) => void
	): Promise<{ bytesTotal: number }>;
	cancel(itemId: string): Promise<void>;
}

export interface FileStore {
	get(fileName: string): Promise<File>;
	remove(fileName: string): Promise<void>;
}

export interface ChannelLike {
	postMessage(message: unknown): void;
	addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface LibraryDeps {
	db: LibraryDb;
	downloader: Downloader;
	files: FileStore;
	/** Item ids some tab is downloading right now (Web Locks held by download workers). */
	activeDownloads: () => Promise<Set<string>>;
	/** Fetch a thumbnail through the relay; null when it cannot be had. */
	fetchThumbnail?: (url: string) => Promise<Blob | null>;
	/** Tells other tabs the library changed. */
	channel?: ChannelLike;
	now?: () => number;
	newId?: () => string;
}

export class Library {
	items = $state<LibraryItem[]>([]);
	/** Progress of downloads running in this tab, by item id. */
	live = $state<Record<string, DownloadProgress>>({});
	loaded = $state(false);

	#deps: LibraryDeps;
	#now: () => number;
	#newId: () => string;

	constructor(deps: LibraryDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#newId = deps.newId ?? (() => crypto.randomUUID());
		deps.channel?.addEventListener('message', () => void this.#refresh());
	}

	async load(): Promise<void> {
		const [items, active] = await Promise.all([this.#deps.db.all(), this.#deps.activeDownloads()]);
		for (const item of items) {
			// A tab closed mid-download leaves "downloading" behind with nobody
			// holding its lock: it is really paused (the bytes so far are kept).
			if (item.status === 'downloading' && !active.has(item.id) && !(item.id in this.live)) {
				item.status = 'paused';
				await this.#deps.db.put(item);
			}
		}
		this.items = items;
		this.loaded = true;
	}

	async add(info: VideoInfo, format: FormatInfo): Promise<LibraryItem> {
		const video = primaryVideo(info);
		const id = this.#newId();
		const plan = downloadPlan(format);
		const item: LibraryItem = {
			id,
			sourceUrl: video.webpage_url ?? format.url,
			videoId: video.id,
			extractor: video.extractor_key ?? video.extractor ?? 'unknown',
			title: video.title,
			uploader: video.uploader ?? undefined,
			duration: video.duration ?? undefined,
			formatId: format.format_id,
			ext: plan.ext,
			kind: formatKind(format),
			resolution: resolutionLabel(format),
			fileName: `${id}.${plan.ext}`,
			bytesTotal: plan.expectedBytes,
			bytesDone: 0,
			status: 'downloading',
			createdAt: this.#now(),
			plan
		};
		await this.#save(item);
		this.items = [item, ...this.items];
		void this.#run(id);
		if (video.thumbnail && this.#deps.fetchThumbnail)
			void this.#attachThumbnail(id, video.thumbnail);
		return item;
	}

	async pause(id: string): Promise<void> {
		await this.#deps.downloader.cancel(id);
	}

	async resume(id: string): Promise<void> {
		const item = this.#find(id);
		if (!item || item.status === 'downloading' || item.status === 'complete') return;
		item.status = 'downloading';
		item.error = undefined;
		await this.#save(item);
		void this.#run(id);
	}

	async remove(id: string): Promise<void> {
		const item = this.#find(id);
		if (!item) return;
		if (item.status === 'downloading') await this.#deps.downloader.cancel(id);
		await this.#deps.files.remove(item.fileName);
		await this.#deps.db.delete(id);
		this.items = this.items.filter((i) => i.id !== id);
		delete this.live[id];
		this.#deps.channel?.postMessage('changed');
	}

	async file(id: string): Promise<File> {
		const item = this.#find(id);
		if (!item) throw new Error(`No library item ${id}`);
		return this.#deps.files.get(item.fileName);
	}

	async #run(id: string): Promise<void> {
		const item = this.#find(id)!;
		this.live[id] = { bytesDone: item.bytesDone, bytesTotal: item.bytesTotal };
		try {
			const { bytesTotal } = await this.#deps.downloader.start(
				{ itemId: id, fileName: item.fileName, plan: $state.snapshot(item.plan) as DownloadPlan },
				(progress) => {
					this.live[id] = progress;
				}
			);
			Object.assign(item, {
				status: 'complete',
				bytesDone: bytesTotal,
				bytesTotal,
				completedAt: this.#now()
			});
		} catch (e) {
			const progress = this.live[id];
			if (progress) item.bytesDone = progress.bytesDone;
			if ((e as Error).name === 'AbortError') {
				item.status = 'paused';
			} else {
				item.status = 'failed';
				item.error = (e as Error).message;
			}
		} finally {
			delete this.live[id];
		}
		if (this.#find(id)) await this.#save(item);
	}

	async #attachThumbnail(id: string, url: string): Promise<void> {
		const blob = await this.#deps.fetchThumbnail!(url).catch(() => null);
		const item = this.#find(id);
		if (!blob || !item) return;
		item.thumbnail = blob;
		await this.#save(item);
	}

	async #refresh(): Promise<void> {
		const items = await this.#deps.db.all();
		// Downloads running here are the source of truth for their own state.
		this.items = items.map((i) => (i.id in this.live ? (this.#find(i.id) ?? i) : i));
	}

	#find(id: string): LibraryItem | undefined {
		return this.items.find((i) => i.id === id);
	}

	async #save(item: LibraryItem): Promise<void> {
		await this.#deps.db.put($state.snapshot(item) as LibraryItem);
		this.#deps.channel?.postMessage('changed');
	}
}
