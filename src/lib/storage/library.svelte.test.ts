import { describe, expect, it, vi } from 'vitest';
import type { FormatInfo, VideoInfo } from '$lib/engine/runtime';
import { bestMergePair } from '$lib/formats';
import type { DownloadProgress } from '$lib/download/download';
import type { LibraryDb, LibraryItem } from './db';
import type { MediaFacts } from './imported';
import { Library, type Downloader, type LibraryDeps, type Remuxer } from './library.svelte';

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
		importFile: vi.fn(
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
		inspect: vi.fn(async (): Promise<MediaFacts> => ({
			duration: 2,
			width: 640,
			height: 360,
			thumbnail: new Blob(['still'], { type: 'image/jpeg' })
		})),
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

describe('imports from this device', () => {
	const picked = () => new File([new Uint8Array(4096)], 'Holiday clip.mp4', { type: 'video/mp4' });
	/** As in IndexedDB: an import some tab started. */
	const stored = (id: string, createdAt: number): LibraryItem => ({
		id,
		origin: 'import',
		title: 't',
		originalName: 't.mp4',
		ext: 'mp4',
		kind: 'av',
		resolution: '360p',
		fileName: `${id}.mp4`,
		bytesTotal: 10,
		bytesDone: 0,
		status: 'importing',
		createdAt
	});

	it('copies the file into storage under the new item, which is complete once it is all there', async () => {
		const { library, deps, downloader } = setup();
		const file = picked();
		const item = await library.importFile(file);
		expect(deps.inspect).toHaveBeenCalledWith(file);
		expect(item).toMatchObject({
			origin: 'import',
			title: 'Holiday clip',
			ext: 'mp4',
			kind: 'av',
			resolution: '360p',
			duration: 2,
			fileName: 'id1.mp4',
			bytesTotal: 4096,
			status: 'importing'
		});
		expect(item.thumbnail).toBeInstanceOf(Blob);
		expect(downloader.importFile).toHaveBeenCalledWith(
			{ itemId: 'id1', fileName: 'id1.mp4', file },
			expect.any(Function)
		);

		downloader.report('id1', { bytesDone: 1024, bytesTotal: 4096 });
		expect(library.live.id1).toEqual({ bytesDone: 1024, bytesTotal: 4096 });

		downloader.finish('id1', 4096);
		await flush();
		expect(library.items[0]).toMatchObject({ status: 'complete', bytesDone: 4096 });
		expect(library.items[0].completedAt).toBeDefined();
		expect(await deps.db.get('id1')).toMatchObject({ status: 'complete', origin: 'import' });
		// Nothing was fetched: no relay is asked for anything.
		expect(downloader.start).not.toHaveBeenCalled();
		expect(deps.fetchThumbnail).not.toHaveBeenCalled();
	});

	it('refuses a file the browser cannot play, and adds nothing', async () => {
		const { library, deps, downloader } = setup({
			inspect: async () => {
				throw new Error("This browser can't play this video's format");
			}
		});
		await expect(library.importFile(picked())).rejects.toThrow(/can't play/);
		expect(library.items).toEqual([]);
		expect(await deps.db.all()).toEqual([]);
		expect(downloader.importFile).not.toHaveBeenCalled();
	});

	it('records a failed copy with its reason, and never offers to resume it: the file was only lent', async () => {
		const { library, downloader } = setup();
		await library.importFile(picked());
		downloader.fail('id1', new DOMException('The quota has been exceeded', 'QuotaExceededError'));
		await flush();
		expect(library.items[0]).toMatchObject({
			status: 'failed',
			error: expect.stringMatching(/quota/)
		});

		await library.resume('id1');
		expect(library.items[0].status).toBe('failed');
		expect(downloader.start).not.toHaveBeenCalled();
		expect(downloader.importFile).toHaveBeenCalledTimes(1);
	});

	it('calls a stopped import failed, never paused', async () => {
		const { library, downloader } = setup();
		await library.importFile(picked());
		await downloader.cancel('id1');
		await flush();
		expect(library.items[0]).toMatchObject({
			status: 'failed',
			error: expect.stringMatching(/stopped/)
		});
	});

	it('on load, marks an import a closed tab interrupted as failed — but not one another tab runs', async () => {
		const db = memoryDb([stored('orphan', 1), stored('elsewhere', 2)]);
		const { library } = setup({ db, activeDownloads: async () => new Set(['elsewhere']) });
		await library.load();
		expect(library.items.find((i) => i.id === 'orphan')).toMatchObject({
			status: 'failed',
			error: expect.stringMatching(/interrupted.*import the file again/i)
		});
		expect(library.items.find((i) => i.id === 'elsewhere')?.status).toBe('importing');
		expect((await db.get('orphan'))?.status).toBe('failed');
	});

	it('removing an import in progress stops the copy and deletes what was copied', async () => {
		const { library, deps, downloader } = setup();
		await library.importFile(picked());
		await library.remove('id1');
		expect(downloader.cancel).toHaveBeenCalledWith('id1');
		expect(deps.files.remove).toHaveBeenCalledWith('id1.mp4');
		expect(library.items).toEqual([]);
		expect(await deps.db.all()).toEqual([]);
	});

	it('refuses to import where nothing can inspect a file', async () => {
		const { library } = setup({ inspect: undefined });
		await expect(library.importFile(picked())).rejects.toThrow(/importing is not available/i);
	});
});

describe('merged downloads', () => {
	const videoOnly: FormatInfo = {
		format_id: '0',
		url: 'https://media.fixtures.test/v.webm',
		ext: 'webm',
		vcodec: 'vp8',
		acodec: 'none',
		height: 360,
		filesize: 30
	};
	const audioOnly: FormatInfo = {
		format_id: '1',
		url: 'https://media.fixtures.test/a.webm',
		ext: 'webm',
		vcodec: 'none',
		acodec: 'opus',
		filesize: 20
	};
	const pair = bestMergePair([videoOnly, audioOnly])!;

	function remuxer() {
		const merges: Parameters<Remuxer['merge']>[0][] = [];
		let settle!: { resolve: (n: number) => void; reject: (e: Error) => void };
		const r: Remuxer = {
			available: async () => true,
			merge: vi.fn((request) => {
				merges.push(request);
				return new Promise<{ bytesTotal: number }>((resolve, reject) => {
					settle = { resolve: (n) => resolve({ bytesTotal: n }), reject };
				});
			})
		};
		return {
			r,
			merges,
			finish: (n: number) => settle.resolve(n),
			fail: (e: Error) => settle.reject(e)
		};
	}

	it('downloads both parts, merges them into one file, then drops the parts', async () => {
		const mux = remuxer();
		const { library, downloader, deps } = setup({ remuxer: mux.r });
		const item = await library.addMerged(video, pair);
		expect(item).toMatchObject({
			formatId: '0+1',
			ext: 'webm',
			kind: 'av',
			resolution: '360p',
			fileName: 'id1.webm',
			bytesTotal: 50
		});
		expect(item.parts?.map((p) => [p.role, p.fileName])).toEqual([
			['video', 'id1.video.webm'],
			['audio', 'id1.audio.webm']
		]);

		// Parts download one after the other, progress summed across both.
		expect(downloader.start).toHaveBeenLastCalledWith(
			expect.objectContaining({ fileName: 'id1.video.webm' }),
			expect.any(Function)
		);
		downloader.report('id1', { bytesDone: 30, bytesTotal: 30 });
		expect(library.live.id1).toEqual({ bytesDone: 30, bytesTotal: 50 });
		downloader.finish('id1', 30);
		await flush();
		expect(downloader.start).toHaveBeenLastCalledWith(
			expect.objectContaining({ fileName: 'id1.audio.webm' }),
			expect.any(Function)
		);
		downloader.report('id1', { bytesDone: 5, bytesTotal: 20 });
		expect(library.live.id1).toEqual({ bytesDone: 35, bytesTotal: 50 });
		downloader.finish('id1', 20);
		await flush();

		expect(library.items[0].status).toBe('merging');
		expect(mux.merges).toEqual([
			{
				itemId: 'id1',
				video: 'id1.video.webm',
				audio: 'id1.audio.webm',
				output: 'id1.webm',
				container: 'webm'
			}
		]);
		mux.finish(48);
		await flush();
		expect(library.items[0]).toMatchObject({ status: 'complete', bytesTotal: 48, bytesDone: 48 });
		expect(deps.files.remove).toHaveBeenCalledWith('id1.video.webm');
		expect(deps.files.remove).toHaveBeenCalledWith('id1.audio.webm');
	});

	it('keeps the parts when merging fails, so a retry only re-merges', async () => {
		const mux = remuxer();
		const { library, downloader, deps } = setup({ remuxer: mux.r });
		await library.addMerged(video, pair);
		downloader.finish('id1', 30);
		await flush();
		downloader.finish('id1', 20);
		await flush();
		mux.fail(new Error('ffmpeg exited with 1'));
		await flush();
		expect(library.items[0]).toMatchObject({ status: 'failed', error: 'ffmpeg exited with 1' });
		expect(deps.files.remove).not.toHaveBeenCalled();
	});

	it('neither resumes nor removes an item while it merges', async () => {
		const mux = remuxer();
		const { library, downloader } = setup({ remuxer: mux.r });
		await library.addMerged(video, pair);
		downloader.finish('id1', 30);
		await flush();
		downloader.finish('id1', 20);
		await flush();
		expect(library.items[0].status).toBe('merging');
		await library.resume('id1');
		expect(downloader.start).toHaveBeenCalledTimes(2);
		await expect(library.remove('id1')).rejects.toThrow(/wait for the merge/i);
		expect(library.items).toHaveLength(1);
	});

	it('removing a merged item deletes its parts too', async () => {
		const { library, deps } = setup({ remuxer: remuxer().r });
		await library.addMerged(video, pair);
		await library.remove('id1');
		expect(
			(deps.files.remove as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).sort()
		).toEqual(['id1.audio.webm', 'id1.video.webm', 'id1.webm']);
	});

	it('refuses to merge without a remuxer', async () => {
		const { library } = setup();
		expect(await library.mergeAvailable()).toBe(false);
		await expect(library.addMerged(video, pair)).rejects.toThrow(/merging is not available/i);
	});

	it('asks the remuxer whether this deployment can merge', async () => {
		const unavailable: Remuxer = { available: async () => false, merge: vi.fn() };
		expect(await setup({ remuxer: unavailable }).library.mergeAvailable()).toBe(false);
		expect(await setup({ remuxer: remuxer().r }).library.mergeAvailable()).toBe(true);
	});
});
