// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openLibraryDb, type LibraryItem } from './db';

const item = (id: string, createdAt: number, extra: Partial<LibraryItem> = {}): LibraryItem => ({
	id,
	sourceUrl: `https://example.test/${id}`,
	videoId: id,
	extractor: 'generic',
	title: `Video ${id}`,
	formatId: '18',
	ext: 'webm',
	kind: 'av',
	resolution: '360p',
	fileName: `${id}.webm`,
	bytesTotal: null,
	bytesDone: 0,
	status: 'downloading',
	createdAt,
	plan: { formatId: '18', url: 'https://m.test/v', ext: 'webm', headers: [], chunkSize: null, expectedBytes: null },
	...extra
});

describe('library database', () => {
	it('stores, updates, lists newest first, and deletes items', async () => {
		const db = await openLibraryDb(new IDBFactory());
		await db.put(item('a', 1));
		await db.put(item('b', 3));
		await db.put(item('c', 2));
		expect((await db.all()).map((i) => i.id)).toEqual(['b', 'c', 'a']);

		await db.put({ ...(await db.get('a'))!, status: 'complete', bytesDone: 10, bytesTotal: 10 });
		expect(await db.get('a')).toMatchObject({ status: 'complete', bytesDone: 10 });

		await db.delete('b');
		expect(await db.get('b')).toBeUndefined();
		expect((await db.all()).map((i) => i.id)).toEqual(['c', 'a']);
	});

	it('keeps thumbnails as Blobs', async () => {
		const db = await openLibraryDb(new IDBFactory());
		await db.put(item('t', 1, { thumbnail: new Blob(['jpeg-bytes'], { type: 'image/jpeg' }) }));
		const stored = await db.get('t');
		expect(stored?.thumbnail).toBeInstanceOf(Blob);
		expect(await stored!.thumbnail!.text()).toBe('jpeg-bytes');
	});

	it('persists across connections', async () => {
		const factory = new IDBFactory();
		await (await openLibraryDb(factory)).put(item('p', 1));
		expect(await (await openLibraryDb(factory)).get('p')).toMatchObject({ title: 'Video p' });
	});
});
