/**
 * The library: what has been (or is being) downloaded or imported from this
 * device, as reactive state. Bytes go to OPFS through the download worker;
 * metadata to IndexedDB. Every I/O dependency is injected (`getLibrary()`
 * wires the browser ones).
 */
import type { FormatInfo, VideoInfo } from '$lib/engine/runtime';
import type { DownloadProgress } from '$lib/download/download';
import {
	downloadPlan,
	formatKind,
	primaryVideo,
	resolutionLabel,
	type DownloadPlan,
	type MergeContainer,
	type MergePair
} from '$lib/formats';
import type { DownloadedItem, LibraryDb, LibraryItem, MergePart } from './db';
import { importedItem, type MediaFacts } from './imported';

export interface DownloadRequest {
	itemId: string;
	fileName: string;
	plan: DownloadPlan;
}

export interface ImportRequest {
	itemId: string;
	/** OPFS file to write. */
	fileName: string;
	/** The file picked on this device. */
	file: File;
}

/** Writes bytes into OPFS: fetched through the relay, or copied from a file on this device. */
export interface Downloader {
	/** Resolves when the file is complete; rejects with an AbortError when cancelled. */
	start(
		request: DownloadRequest,
		onProgress: (progress: DownloadProgress) => void
	): Promise<{ bytesTotal: number }>;
	/** Copies a picked file in; rejects with an AbortError when cancelled. */
	importFile(
		request: ImportRequest,
		onProgress: (progress: DownloadProgress) => void
	): Promise<{ bytesTotal: number }>;
	/** Stops a download or an import. */
	cancel(itemId: string): Promise<void>;
}

export interface MergeRequest {
	itemId: string;
	/** OPFS files to read. */
	video: string;
	audio: string;
	/** OPFS file to write. */
	output: string;
	container: MergeContainer;
}

/** Remuxes (stream copy, no re-encoding) separate video and audio into one file. */
export interface Remuxer {
	/** Whether this deployment ships an FFmpeg core (YT_DLP_WEB_FFMPEG=0 leaves it out). */
	available(): Promise<boolean>;
	/**
	 * Starts loading FFmpeg for a merge to come, so the merge finds it ready.
	 * Returns the release: FFmpeg goes once every preparation and merge has ended.
	 */
	prepare?(): () => void;
	merge(request: MergeRequest): Promise<{ bytesTotal: number }>;
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
	/** FFmpeg in the remux worker; absent when the deployment does not ship it. */
	remuxer?: Remuxer;
	files: FileStore;
	/** Item ids some tab is downloading right now (Web Locks held by download workers). */
	activeDownloads: () => Promise<Set<string>>;
	/** Fetch a thumbnail through the relay; null when it cannot be had. Absent without a relay. */
	fetchThumbnail?: (url: string) => Promise<Blob | null>;
	/** Open a picked file the way playback will: rejects when the browser cannot play it. */
	inspect?: (file: File) => Promise<MediaFacts>;
	/** Tells other tabs the library changed. */
	channel?: ChannelLike;
	now?: () => number;
	newId?: () => string;
}

export class Library {
	items = $state<LibraryItem[]>([]);
	/** Progress of downloads and imports running in this tab, by item id. */
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
			// An import cannot go on: the picked file went with the tab.
			const busy =
				item.status === 'downloading' || item.status === 'merging' || item.status === 'importing';
			if (busy && !active.has(item.id) && !(item.id in this.live)) {
				if (item.origin === 'import') {
					item.status = 'failed';
					item.error = 'The import was interrupted: delete this and import the file again.';
				} else {
					item.status = 'paused';
				}
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
		const item: DownloadedItem = {
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
		this.#fetch(id);
		if (video.thumbnail && this.#deps.fetchThumbnail)
			void this.#attachThumbnail(id, video.thumbnail);
		return item;
	}

	/**
	 * Copy a media file from this device into the library. The browser opens it
	 * first, as playback will: a file it cannot play is refused before anything
	 * is stored. Resolves once the item exists; the copy runs on, like a download.
	 */
	async importFile(file: File): Promise<LibraryItem> {
		if (!this.#deps.inspect) throw new Error('Importing is not available here');
		const media = await this.#deps.inspect(file);
		const item = importedItem({ id: this.#newId(), file, media, now: this.#now() });
		await this.#save(item);
		this.items = [item, ...this.items];
		void this.#run(item.id, async (current) => {
			const { bytesTotal } = await this.#deps.downloader.importFile(
				{ itemId: current.id, fileName: current.fileName, file },
				(progress) => {
					this.live[current.id] = progress;
				}
			);
			return bytesTotal;
		});
		return item;
	}

	/** Download the best video-only and audio-only streams and remux them into one file. */
	async addMerged(info: VideoInfo, pair: MergePair): Promise<LibraryItem> {
		if (!this.#deps.remuxer) throw new Error('Merging is not available on this deployment');
		const video = primaryVideo(info);
		const id = this.#newId();
		const part = (role: MergePart['role'], format: FormatInfo): MergePart => {
			const plan = downloadPlan(format);
			return { role, formatId: format.format_id, fileName: `${id}.${role}.${plan.ext}`, plan };
		};
		const parts = [part('video', pair.video), part('audio', pair.audio)];
		const sizes = parts.map((p) => p.plan.expectedBytes);
		const item: DownloadedItem = {
			id,
			sourceUrl: video.webpage_url ?? pair.video.url,
			videoId: video.id,
			extractor: video.extractor_key ?? video.extractor ?? 'unknown',
			title: video.title,
			uploader: video.uploader ?? undefined,
			duration: video.duration ?? undefined,
			formatId: `${pair.video.format_id}+${pair.audio.format_id}`,
			ext: pair.container,
			kind: 'av',
			resolution: resolutionLabel(pair.video),
			fileName: `${id}.${pair.container}`,
			bytesTotal: sizes.every((n) => n !== null) ? sizes.reduce((a, b) => a! + b!, 0) : null,
			bytesDone: 0,
			status: 'downloading',
			createdAt: this.#now(),
			plan: parts[0].plan,
			parts
		};
		await this.#save(item);
		this.items = [item, ...this.items];
		this.#fetch(id);
		if (video.thumbnail && this.#deps.fetchThumbnail)
			void this.#attachThumbnail(id, video.thumbnail);
		return item;
	}

	/** Whether `addMerged` can work here. */
	async mergeAvailable(): Promise<boolean> {
		return (await this.#deps.remuxer?.available()) ?? false;
	}

	async pause(id: string): Promise<void> {
		await this.#deps.downloader.cancel(id);
	}

	/** Restart a paused or failed download. Imports cannot be: the picked file was only lent. */
	async resume(id: string): Promise<void> {
		const item = this.#find(id);
		if (item?.status !== 'paused' && item?.status !== 'failed') return;
		if (item.origin === 'import') return;
		item.status = 'downloading';
		item.error = undefined;
		await this.#save(item);
		this.#fetch(id);
	}

	async remove(id: string): Promise<void> {
		const item = this.#find(id);
		if (!item) return;
		// ffmpeg holds the files and cannot be interrupted; merges take seconds.
		if (item.status === 'merging') throw new Error('Wait for the merge to finish');
		if (item.status === 'downloading' || item.status === 'importing')
			await this.#deps.downloader.cancel(id);
		await this.#deps.files.remove(item.fileName);
		for (const part of item.parts ?? []) await this.#deps.files.remove(part.fileName);
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

	/** Run a download (or a download and merge) through the relay. */
	#fetch(id: string): void {
		void this.#run(id, (item) => {
			if (item.origin === 'import') throw new Error('An imported file cannot be fetched');
			return item.parts ? this.#downloadAndMerge(item) : this.#download(item);
		});
	}

	/** Run `work` on the item, which ends complete, paused or failed. */
	async #run(id: string, work: (item: LibraryItem) => Promise<number>): Promise<void> {
		const item = this.#find(id)!;
		this.live[id] = { bytesDone: item.bytesDone, bytesTotal: item.bytesTotal };
		try {
			const bytesTotal = await work(item);
			Object.assign(item, {
				status: 'complete',
				bytesDone: bytesTotal,
				bytesTotal,
				completedAt: this.#now()
			});
		} catch (e) {
			const progress = this.live[id];
			if (progress) item.bytesDone = progress.bytesDone;
			if (item.origin === 'import') {
				item.status = 'failed';
				item.error =
					(e as Error).name === 'AbortError' ? 'The import was stopped' : (e as Error).message;
			} else if ((e as Error).name === 'AbortError') {
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

	async #download(item: DownloadedItem): Promise<number> {
		const { bytesTotal } = await this.#deps.downloader.start(
			{
				itemId: item.id,
				fileName: item.fileName,
				plan: $state.snapshot(item.plan) as DownloadPlan
			},
			(progress) => {
				this.live[item.id] = progress;
			}
		);
		return bytesTotal;
	}

	/**
	 * FFmpeg loads while the parts download: the merge finds it ready, instead of
	 * the item sitting at "merging" while tens of megabytes of core arrive. It is
	 * let go when the merge ends, or the download pauses or fails.
	 */
	async #downloadAndMerge(item: DownloadedItem): Promise<number> {
		const release = this.#deps.remuxer!.prepare?.();
		try {
			return await this.#downloadThenMerge(item);
		} finally {
			release?.();
		}
	}

	/**
	 * Parts download one at a time under the item's id (and so its Web Lock);
	 * a finished part answers its next range request with 416 at once, so a
	 * resume or a retry after a failed merge skips straight past it.
	 */
	async #downloadThenMerge(item: DownloadedItem): Promise<number> {
		let done = 0;
		for (const part of item.parts!) {
			const { bytesTotal } = await this.#deps.downloader.start(
				{
					itemId: item.id,
					fileName: part.fileName,
					plan: $state.snapshot(part.plan) as DownloadPlan
				},
				(progress) => {
					this.live[item.id] = {
						bytesDone: done + progress.bytesDone,
						bytesTotal: item.bytesTotal
					};
				}
			);
			done += bytesTotal;
		}
		item.status = 'merging';
		await this.#save(item);
		const [video, audio] = item.parts!;
		const { bytesTotal } = await this.#deps.remuxer!.merge({
			itemId: item.id,
			video: video.fileName,
			audio: audio.fileName,
			output: item.fileName,
			container: item.ext as MergeContainer
		});
		for (const part of item.parts!) await this.#deps.files.remove(part.fileName);
		return bytesTotal;
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
