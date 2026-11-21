import { describe, expect, it } from 'vitest';
import type { LibraryItem } from './db';
import {
	BRAVE_QUOTA,
	exportFileName,
	libraryBytes,
	progressLabel,
	statusLabel,
	storageRoom
} from './present';

describe('exportFileName', () => {
	it('builds "<title> [<format>].<ext>"', () => {
		expect(exportFileName({ title: 'Big Buck Bunny', formatId: '18', ext: 'mp4' })).toBe(
			'Big Buck Bunny [18].mp4'
		);
	});

	it('replaces characters no file system accepts, and trailing dots/spaces', () => {
		expect(
			exportFileName({ title: 'a/b\\c:d*e?f"g<h>i|j\u0007. ', formatId: 'x', ext: 'webm' })
		).toBe('a_b_c_d_e_f_g_h_i_j_ [x].webm');
	});

	it('never lets a title escape into a path or hide as a dotfile', () => {
		// Separators become "_" and a leading run of dots collapses to one "_".
		expect(exportFileName({ title: '../../etc/passwd', formatId: '1', ext: 'mp4' })).toBe(
			'__.._etc_passwd [1].mp4'
		);
		expect(exportFileName({ title: '.bashrc', formatId: '1', ext: 'mp4' })).toBe('_bashrc [1].mp4');
		expect(exportFileName({ title: '', formatId: '1', ext: 'mp4' })).toBe('video [1].mp4');
	});

	it('names an imported file "<title>.<ext>": it has no format', () => {
		expect(exportFileName({ title: 'Holiday clip', ext: 'mp4' })).toBe('Holiday clip.mp4');
		expect(exportFileName({ title: 'a:b', ext: 'mkv' })).toBe('a_b.mkv');
	});

	it('keeps names to a sane length', () => {
		expect(
			exportFileName({ title: 'x'.repeat(500), formatId: '1', ext: 'mp4' }).length
		).toBeLessThanOrEqual(180);
	});
});

describe('progress', () => {
	it('shows percent when the size is known', () => {
		expect(progressLabel({ bytesDone: 512 * 1024, bytesTotal: 2 * 1024 * 1024 })).toBe(
			'25% · 512.0 KiB of 2.0 MiB'
		);
	});
	it('shows bytes when it is not', () => {
		expect(progressLabel({ bytesDone: 1536, bytesTotal: null })).toBe('1.5 KiB');
	});
	it('describes statuses in words', () => {
		expect(statusLabel('complete')).toBe('Downloaded');
		expect(statusLabel('paused')).toBe('Paused');
		expect(statusLabel('merging')).toBe('Merging');
		expect(statusLabel('importing')).toBe('Importing');
		// A file from this device was imported, not downloaded.
		expect(statusLabel('complete', 'import')).toBe('Imported');
		expect(statusLabel('complete', 'download')).toBe('Downloaded');
		expect(statusLabel('failed', 'import')).toBe('Failed');
	});
});

describe('libraryBytes', () => {
	const item = (fields: Partial<LibraryItem>): LibraryItem =>
		({
			id: 'x',
			title: 'x',
			ext: 'webm',
			fileName: 'x.webm',
			bytesTotal: null,
			bytesDone: 0,
			status: 'complete',
			createdAt: 0,
			...fields
		}) as LibraryItem;

	it("counts what the library's own items hold: their files and thumbnails", () => {
		const items = [
			item({ id: 'a', status: 'complete', bytesTotal: 1000, bytesDone: 1000 }),
			item({ id: 'b', status: 'paused', bytesTotal: 5000, bytesDone: 300 }),
			item({ id: 'c', status: 'failed', bytesTotal: null, bytesDone: 20 }),
			item({
				id: 'd',
				status: 'complete',
				bytesTotal: 7,
				bytesDone: 7,
				thumbnail: new Blob(['jpeg'])
			})
		];
		expect(libraryBytes(items, {})).toBe(1000 + 300 + 20 + 7 + 4);
	});

	it('follows downloads and imports as they run', () => {
		const items = [item({ id: 'a', status: 'downloading', bytesTotal: 5000, bytesDone: 100 })];
		expect(libraryBytes(items, { a: { bytesDone: 2500, bytesTotal: 5000 } })).toBe(2500);
	});

	it('is nothing for an empty library', () => {
		expect(libraryBytes([], {})).toBe(0);
	});
});

describe('storageRoom', () => {
	const GiB = 2 ** 30;

	it('is what the quota leaves of what the site uses', () => {
		expect(storageRoom({ usage: 3 * GiB, quota: 10 * GiB })).toBe(7 * GiB);
		expect(storageRoom({ quota: 10 * GiB })).toBe(10 * GiB);
		// Used up to the byte: the quota may well be real, and full.
		expect(storageRoom({ usage: 10 * GiB, quota: 10 * GiB })).toBe(0);
	});

	it('says nothing where the browser gives no quota', () => {
		expect(storageRoom({})).toBeNull();
		expect(storageRoom({ usage: GiB, quota: 0 })).toBeNull();
	});

	// Brave reports the same quota to every site, whatever it stores and whatever
	// it may store: with a library past 2 GiB the page said "room for 0 B more".
	it("says nothing of Brave's fixed quota, above it or below it", () => {
		expect(BRAVE_QUOTA).toBe(2147483648);
		expect(storageRoom({ usage: 3 * GiB, quota: BRAVE_QUOTA })).toBeNull();
		expect(storageRoom({ usage: GiB / 2, quota: BRAVE_QUOTA })).toBeNull();
	});

	it('says nothing of a quota the site has already gone past: it is no limit', () => {
		expect(storageRoom({ usage: 5 * GiB + 1, quota: 5 * GiB })).toBeNull();
	});
});
