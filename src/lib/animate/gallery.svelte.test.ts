// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Animation } from './editor.svelte';
import { AnimationGallery, describeAnimation, getGallery, madeFileName } from './gallery.svelte';

function animation(overrides: Partial<Animation> = {}): Animation {
	return {
		format: 'gif',
		blob: new Blob([new Uint8Array(100)], { type: 'image/gif' }),
		width: 480,
		height: 270,
		frames: 24,
		duration: 2,
		range: { start: 0, end: 2 },
		...overrides
	};
}

function setup() {
	let now = 1_000;
	const gallery = new AnimationGallery(() => now);
	return { gallery, tick: (ms: number) => (now += ms) };
}

describe('AnimationGallery', () => {
	it('starts empty', () => {
		const { gallery } = setup();
		expect(gallery.items).toEqual([]);
		expect(gallery.bytes).toBe(0);
	});

	it('keeps each animation made, newest first, with the video it was made of', () => {
		const { gallery, tick } = setup();
		const gif = gallery.add(animation(), { title: 'Big Buck Fixture', formatId: '0' });
		tick(5_000);
		const apng = gallery.add(
			animation({ format: 'apng', blob: new Blob([new Uint8Array(300)], { type: 'image/png' }) }),
			{ title: 'bbf-360' }
		);
		expect(gallery.items).toEqual([apng, gif]);
		expect(gif).toMatchObject({
			format: 'gif',
			width: 480,
			source: { title: 'Big Buck Fixture', formatId: '0' },
			madeAt: 1_000
		});
		expect(apng).toMatchObject({ format: 'apng', source: { title: 'bbf-360' }, madeAt: 6_000 });
		expect(gif.id).not.toBe(apng.id);
		expect(gallery.get(gif.id)).toBe(gif);
		// What they hold, together.
		expect(gallery.bytes).toBe(400);
	});

	it('copies what it is given: changing the source or the range later changes nothing kept', () => {
		const { gallery } = setup();
		const source = { title: 'Big Buck Fixture', formatId: '0', thumbnail: new Blob(['a still']) };
		const range = { start: 0.5, end: 1.5 };
		const kept = gallery.add(animation({ range }), source);
		source.title = 'Renamed';
		range.end = 9;
		expect(kept.source).toEqual({ title: 'Big Buck Fixture', formatId: '0' });
		expect(kept.range).toEqual({ start: 0.5, end: 1.5 });
	});

	it('removes one, keeping the others in order; an unknown one is no matter', () => {
		const { gallery } = setup();
		const first = gallery.add(animation(), { title: 'one' });
		const second = gallery.add(animation(), { title: 'two' });
		const third = gallery.add(animation(), { title: 'three' });
		gallery.remove(second.id);
		expect(gallery.items).toEqual([third, first]);
		expect(gallery.get(second.id)).toBeUndefined();
		expect(gallery.bytes).toBe(200);
		gallery.remove('nothing');
		expect(gallery.items).toEqual([third, first]);
		// Ids are never given twice, even after a removal.
		expect(gallery.add(animation(), { title: 'four' }).id).not.toBe(second.id);
	});

	it('is one per page: what a page makes stays while it is open, never stored', () => {
		expect(getGallery()).toBe(getGallery());
		// A page loaded afresh starts with a gallery of its own, empty.
		expect(new AnimationGallery().items).toEqual([]);
	});
});

describe('madeFileName', () => {
	it('names the file after the video, the stretch it was made of and its format', () => {
		const { gallery } = setup();
		const kept = gallery.add(animation({ format: 'apng', range: { start: 0.5, end: 1.5 } }), {
			title: 'Big Buck Fixture',
			formatId: '0'
		});
		expect(madeFileName(kept)).toBe('Big Buck Fixture (0.5s-1.5s) [0].png');
		const fromDisk = gallery.add(animation(), { title: 'bbf-360' });
		expect(madeFileName(fromDisk)).toBe('bbf-360 (0.0s-2.0s).gif');
	});
});

describe('describeAnimation', () => {
	it('names an animation by its format, its video and the stretch of it', () => {
		const { gallery } = setup();
		const kept = gallery.add(animation({ format: 'jxl', range: { start: 0.5, end: 61.5 } }), {
			title: 'Big Buck Fixture',
			formatId: '0'
		});
		expect(describeAnimation(kept)).toBe('JPEG XL of Big Buck Fixture, 0:00.5 to 1:01.5');
	});
});
