// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { importedExt, importedItem, importedTitle, type MediaFacts } from './imported';

const video: MediaFacts = { duration: 2, width: 640, height: 360, thumbnail: null };

describe('an imported file', () => {
	it('becomes a library item of its own name, size and shape, importing', () => {
		const item = importedItem({
			id: 'id1',
			file: { name: 'Holiday clip.mp4', type: 'video/mp4', size: 4096 },
			media: video,
			now: 1000
		});
		expect(item).toEqual({
			id: 'id1',
			origin: 'import',
			title: 'Holiday clip',
			originalName: 'Holiday clip.mp4',
			duration: 2,
			ext: 'mp4',
			kind: 'av',
			resolution: '360p',
			fileName: 'id1.mp4',
			bytesTotal: 4096,
			bytesDone: 0,
			status: 'importing',
			createdAt: 1000
		});
	});

	it('keeps the still taken from the video as its thumbnail', () => {
		const thumbnail = new Blob(['jpg'], { type: 'image/jpeg' });
		const item = importedItem({
			id: 'id1',
			file: { name: 'a.webm', type: 'video/webm', size: 1 },
			media: { ...video, thumbnail },
			now: 0
		});
		expect(item.thumbnail).toBe(thumbnail);
	});

	it('is sound only when it has no picture', () => {
		const item = importedItem({
			id: 'id1',
			file: { name: 'song.opus', type: 'audio/ogg', size: 1 },
			media: { duration: 180.5, width: 0, height: 0, thumbnail: null },
			now: 0
		});
		expect(item).toMatchObject({ kind: 'audio', resolution: 'audio only', ext: 'opus' });
	});

	it('states no length the browser could not tell', () => {
		const item = importedItem({
			id: 'id1',
			file: { name: 'live.webm', type: 'video/webm', size: 1 },
			media: { ...video, duration: Infinity },
			now: 0
		});
		expect(item.duration).toBeUndefined();
	});
});

describe('importedTitle', () => {
	it('is the file name without its extension', () => {
		expect(importedTitle('Big Buck Fixture.webm')).toBe('Big Buck Fixture');
		expect(importedTitle('archive.tar.mkv')).toBe('archive.tar');
		expect(importedTitle('  spaced out .mp4')).toBe('spaced out');
		expect(importedTitle('no extension')).toBe('no extension');
	});

	it('never comes out empty', () => {
		expect(importedTitle('.mp4')).toBe('.mp4');
		expect(importedTitle('')).toBe('Video');
	});
});

describe('importedExt', () => {
	it("is the name's extension, lower case", () => {
		expect(importedExt('clip.MKV', 'video/x-matroska')).toBe('mkv');
		expect(importedExt('clip.webm', '')).toBe('webm');
	});

	it('comes from the type when the name has none', () => {
		expect(importedExt('clip', 'video/mp4')).toBe('mp4');
		expect(importedExt('clip', 'video/quicktime')).toBe('mov');
		expect(importedExt('clip', 'video/x-matroska')).toBe('mkv');
		expect(importedExt('clip', 'audio/mpeg')).toBe('mp3');
		expect(importedExt('clip', 'video/x-flv')).toBe('flv');
	});

	it('is a plain token, whatever the name says', () => {
		expect(importedExt('clip.we/bm', '')).toBe('bin');
		expect(importedExt('clip.thisistoolongforone', '')).toBe('bin');
		expect(importedExt('clip', '')).toBe('bin');
	});
});
