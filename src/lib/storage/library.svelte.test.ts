import { describe, expect, it, vi } from 'vitest';
import type { FormatInfo, VideoInfo } from '$lib/engine/runtime';
import type { DownloadProgress } from '$lib/download/download';
import type { LibraryDb, LibraryItem } from './db';
import { Library, type Downloader, type LibraryDeps } from './library.svelte';

function memoryDb(initial: LibraryItem[] = []): LibraryDb {
	const rows = new Map(initial.map((i) => [i.id, structuredClone(i)]));
	return {
		all: async () =>
			[...rows.values()].sort((a, b) => b.createdAt - a.createdAt).map((i) => structuredClone(i)),
		get: async (id) => structuredClone(rows.get(id)),
		put: async (item) =>
			void rows.set(item.id, structuredClone($state.snapshot(item) as LibraryItem)),
		delete: async (id) => void rows.delete(id)
	};
}

/** A downloader whose downloads finish only when the test says so. */
function controllableDownloader() {
	const running = new Map<
		string,
		{
			resolve: (total: number) => void;
			reject: (e: Error) => void;
			progress: (p: DownloadProgress) => void;
		}
	>();
	const downloader: Downloader & {
		finish(id: string, total: number): void;
		fail(id: string, e: Error): void;
		report(id: string, p: DownloadProgress): void;
	} = {
		start: vi.fn(
			(request, onProgress) =>
				new Promise<{ bytesTotal: number }>((resolve, reject) => {
					running.set(request.itemId, {
						resolve: (bytesTotal) => resolve({ bytesTotal }),
						reject,
						progress: onProgress
					});
				})
		),
		cancel: vi.fn(async (itemId: string) => {
			running.get(itemId)?.reject(new DOMException('aborted', 'AbortError'));
		}),
		finish: (id, total) => running.get(id)!.resolve(total),
		fail: (id, e) => running.get(id)!.reject(e),
		report: (id, p) => running.get(id)!.progress(p)
	};
	return downloader;
}

const video: VideoInfo = {
	id: 'abc',
	title: 'Big Buck Fixture',
	webpage_url: 'https://www.fixtures.test/watch',
	extractor_key: 'Generic',
	uploader: 'Blender',
	duration: 2,
	thumbnail: 'https://i.fixtures.test/abc.jpg'
};
const format: FormatInfo = {
	format_id: '1',
	url: 'https://media.fixtures.test/bbf-360.webm',
	ext: 'webm',
	height: 360,
	vcodec: 'vp8',
	acodec: 'none',
	http_headers: { 'User-Agent': 'UA' }
};

function setup(overrides: Partial<LibraryDeps> = {}) {
	let n = 0;
	const deps: LibraryDeps = {
		db: memoryDb(),
		downloader: controllableDownloader(),
		files: {
			get: vi.fn(async (name: string) => new File(['x'], name)),
			remove: vi.fn(async () => {})
		},
		activeDownloads: async () => new Set(),
		fetchThumbnail: vi.fn(async () => new Blob(['jpg'], { type: 'image/jpeg' })),
		now: () => 1000 + n,
		newId: () => `id${++n}`,
		...overrides
	};
	return {
		library: new Library(deps),
		deps,
		downloader: deps.downloader as ReturnType<typeof controllableDownloader>
	};
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Library', () => {
	it('adds a download, tracks its progress and completes it', async () => {
		const { library, downloader } = setup();
		const item = await library.add(video, format);
		expect(item).toMatchObject({
			title: 'Big Buck Fixture',
			sourceUrl: 'https://www.fixtures.test/watch',
			formatId: '1',
			kind: 'video',
			resolution: '360p',
			fileName: 'id1.webm',
			status: 'downloading'
		});
		expect(downloader.start).toHaveBeenCalledWith(
			expect.objectContaining({
				itemId: 'id1',
				fileName: 'id1.webm',
				plan: expect.objectContaining({ url: format.url, headers: [['User-Agent', 'UA']] })
			}),
			expect.any(Function)
		);

		downloader.report('id1', { bytesDone: 10, bytesTotal: 40 });
		expect(library.live.id1).toEqual({ bytesDone: 10, bytesTotal: 40 });

		downloader.finish('id1', 40);
		await flush();
		expect(library.items[0]).toMatchObject({ status: 'complete', bytesDone: 40, bytesTotal: 40 });
		expect(library.items[0].completedAt).toBeDefined();
		expect(library.live.id1).toBeUndefined();
	});

	it('keeps a thumbnail fetched through the relay', async () => {
		const { library, deps } = setup();
		await library.add(video, format);
		await flush();
		expect(deps.fetchThumbnail).toHaveBeenCalledWith('https://i.fixtures.test/abc.jpg');
		expect(library.items[0].thumbnail).toBeInstanceOf(Blob);
	});

	it('pauses without calling it a failure, and resumes', async () => {
		const { library, downloader } = setup();
		await library.add(video, format);
		await library.pause('id1');
		await flush();
		expect(library.items[0].status).toBe('paused');
		expect(library.items[0].error).toBeUndefined();

		await library.resume('id1');
		expect(library.items[0].status).toBe('downloading');
		expect(downloader.start).toHaveBeenCalledTimes(2);
	});

	it('records failures with their reason', async () => {
		const { library, downloader } = setup();
		await library.add(video, format);
		downloader.fail('id1', new Error('HTTP 403 — the media link has probably expired'));
		await flush();
		expect(library.items[0]).toMatchObject({
			status: 'failed',
			error: expect.stringMatching(/expired/)
		});
	});

	it('removes an item: stops it, deletes its file and its record', async () => {
		const { library, deps, downloader } = setup();
		await library.add(video, format);
		await library.remove('id1');
		expect(downloader.cancel).toHaveBeenCalledWith('id1');
		expect(deps.files.remove).toHaveBeenCalledWith('id1.webm');
		expect(library.items).toEqual([]);
		expect(await deps.db.all()).toEqual([]);
	});

	it('on load, marks downloads orphaned by a closed tab as paused — but not ones another tab runs', async () => {
		const base = {
			sourceUrl: 's',
			videoId: 'v',
			extractor: 'e',
			title: 't',
			formatId: 'f',
			ext: 'webm',
			kind: 'av' as const,
			resolution: '—',
			bytesTotal: null,
			bytesDone: 5,
			createdAt: 1,
			plan: {
				formatId: 'f',
				url: 'u',
				ext: 'webm',
				headers: [],
				chunkSize: null,
				expectedBytes: null
			}
		};
		const db = memoryDb([
			{ ...base, id: 'orphan', fileName: 'orphan.webm', status: 'downloading' },
			{ ...base, id: 'elsewhere', fileName: 'elsewhere.webm', status: 'downloading', createdAt: 2 }
		]);
		const { library } = setup({ db, activeDownloads: async () => new Set(['elsewhere']) });
		await library.load();
		expect(Object.fromEntries(library.items.map((i) => [i.id, i.status]))).toEqual({
			orphan: 'paused',
			elsewhere: 'downloading'
		});
	});

	it('hands out the stored file for playback or export', async () => {
		const { library, downloader } = setup();
		await library.add(video, format);
		downloader.finish('id1', 1);
		await flush();
		expect((await library.file('id1')).name).toBe('id1.webm');
	});

	it('reloads when another tab changes the library', async () => {
		const listeners: ((e: MessageEvent) => void)[] = [];
		const channel = {
			postMessage: vi.fn(),
			addEventListener: (_: 'message', l: (e: MessageEvent) => void) => listeners.push(l)
		};
		const db = memoryDb();
		const { library } = setup({ db, channel });
		await library.load();
		await db.put({
			id: 'x',
			sourceUrl: 's',
			videoId: 'v',
			extractor: 'e',
			title: 'From another tab',
			formatId: 'f',
			ext: 'webm',
			kind: 'av',
			resolution: '—',
			fileName: 'x.webm',
			bytesTotal: 1,
			bytesDone: 1,
			status: 'complete',
			createdAt: 5,
			plan: {
				formatId: 'f',
				url: 'u',
				ext: 'webm',
				headers: [],
				chunkSize: null,
				expectedBytes: null
			}
		});
		listeners.forEach((l) => l(new MessageEvent('message', { data: 'changed' })));
		await flush();
		expect(library.items.map((i) => i.title)).toEqual(['From another tab']);
	});
});
