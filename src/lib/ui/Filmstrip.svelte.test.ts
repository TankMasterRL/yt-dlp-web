import { flushSync } from 'svelte';
import { render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimeRange } from '$lib/animate/clip';
import type { OpenedVideo } from '$lib/animate/frames';
import { FakeResizeObserver, resizeAll } from '../../../tests/helpers/resize-observer';
import { FakeVideo } from '../../../tests/helpers/video';
import Filmstrip from './Filmstrip.svelte';

const media = { width: 640, height: 360, duration: 2 };

/** jsdom draws nothing: each canvas notes the time of the picture on screen whenever it is drawn on. */
function recordDraws(video: FakeVideo) {
	const draws = new Map<HTMLCanvasElement, number[][]>();
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
		this: HTMLCanvasElement
	) {
		return {
			drawImage: (_image: CanvasImageSource, ...at: number[]) => {
				draws.set(this, [...(draws.get(this) ?? []), [video.shown, ...at]]);
			}
		} as unknown as CanvasRenderingContext2D;
	});
	return draws;
}

function setup(view: TimeRange | null = null) {
	const video = new FakeVideo();
	const opened: OpenedVideo = {
		video: video as unknown as OpenedVideo['video'],
		close: vi.fn()
	};
	const file = new Blob(['a video']);
	const open = vi.fn((_file: Blob) => opened);
	const draws = recordDraws(video);
	const props = $state({ view });
	const { container, unmount } = render(Filmstrip, {
		file,
		media,
		open,
		get view() {
			return props.view;
		}
	});
	const strip = container.querySelector<HTMLElement>('.filmstrip')!;
	const canvases = () => [...strip.querySelectorAll('canvas')];
	return { props, video, opened, file, open, draws, strip, canvases, unmount };
}

/** Waits until the strip says it has drawn `count` pictures. */
async function drawn(strip: HTMLElement, count: number) {
	await vi.waitFor(() => expect(strip).toHaveAttribute('data-taken', String(count)));
}

describe('Filmstrip', () => {
	beforeEach(() => vi.stubGlobal('ResizeObserver', FakeResizeObserver));
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('opens the file in a video of its own', () => {
		const { open, file } = setup();
		expect(open).toHaveBeenCalledExactlyOnceWith(file);
	});

	it('shows nothing until it is laid out', async () => {
		const { canvases, video } = setup();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(canvases()).toEqual([]);
		expect(video.seeks).toEqual([]);
	});

	it('fills its width with pictures from across the video, each the middle of its stretch', async () => {
		const { strip, canvases, video, draws } = setup();
		// 320 × 44: 16:9 pictures 78 px wide, five of them.
		resizeAll(320, 44);
		flushSync();
		expect(canvases().map((c) => c.dataset.time)).toEqual(['0.2', '0.6', '1', '1.4', '1.8']);
		await drawn(strip, 5);
		expect(video.seeks).toEqual([0.2, 0.6, 1, 1.4, 1.8]);
		for (const [i, canvas] of canvases().entries()) {
			expect([canvas.width, canvas.height]).toEqual([78, 44]);
			expect(draws.get(canvas)).toEqual([[[0.2, 0.6, 1, 1.4, 1.8][i], 0, 0, 78, 44]]);
		}
	});

	it('takes them again when another number fits, but not for every pixel', async () => {
		const { strip, canvases, video } = setup();
		resizeAll(320, 44);
		flushSync();
		await drawn(strip, 5);
		// Still five.
		resizeAll(330, 44);
		flushSync();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(video.seeks).toHaveLength(5);
		// Three.
		video.seeks = [];
		resizeAll(160, 44);
		flushSync();
		expect(canvases()).toHaveLength(3);
		await drawn(strip, 3);
		expect(video.seeks).toEqual([0.333333, 1, 1.666667]);
	});

	it('shows where pictures are still coming, until every one is drawn', async () => {
		const { strip, video } = setup();
		video.answers = false;
		resizeAll(320, 44);
		flushSync();
		expect(strip).toHaveClass('taking');
		await vi.waitFor(() => expect(video.seeks).toHaveLength(1));
		expect(strip).toHaveClass('taking');
		// The stuck seek ends; the rest answer.
		video.answers = true;
		video.dispatchEvent(new Event('seeked'));
		await drawn(strip, 5);
		expect(strip).not.toHaveClass('taking');
	});

	it('takes them again, sharper, when it grows taller', async () => {
		const { strip, canvases, video } = setup();
		resizeAll(320, 44);
		flushSync();
		await drawn(strip, 5);
		video.seeks = [];
		resizeAll(640, 88);
		flushSync();
		await drawn(strip, 5);
		expect(video.seeks).toHaveLength(5);
		expect([canvases()[0].width, canvases()[0].height]).toEqual([156, 88]);
	});

	it('shows the stretch the timeline is zoomed in on', async () => {
		const { strip, canvases, video } = setup({ start: 1, end: 1.5 });
		resizeAll(320, 44);
		flushSync();
		expect(canvases().map((c) => c.dataset.time)).toEqual(['1.05', '1.15', '1.25', '1.35', '1.45']);
		await drawn(strip, 5);
		expect(video.seeks).toEqual([1.05, 1.15, 1.25, 1.35, 1.45]);
	});

	it('takes them again where the zoom moves, the old pictures shown faded until each is replaced', async () => {
		const { props, strip, canvases, video, draws } = setup();
		resizeAll(320, 44);
		flushSync();
		await drawn(strip, 5);
		const before = canvases();
		video.seeks = [];
		video.answers = false;
		props.view = { start: 0, end: 1 };
		flushSync();
		// The same canvases, not cleared: what they showed stays until the new picture is in.
		expect(canvases()).toEqual(before);
		expect(canvases().map((c) => c.dataset.time)).toEqual(['0.1', '0.3', '0.5', '0.7', '0.9']);
		expect(canvases().every((c) => c.classList.contains('stale'))).toBe(true);
		expect(draws.get(before[0])).toHaveLength(1);
		await vi.waitFor(() => expect(video.seeks).toEqual([0.1]));
		video.answers = true;
		video.dispatchEvent(new Event('seeked'));
		await drawn(strip, 5);
		expect(canvases().some((c) => c.classList.contains('stale'))).toBe(false);
		expect(draws.get(before[4])!.at(-1)).toEqual([0.9, 0, 0, 78, 44]);
	});

	it('takes only the latest stretch while the zoom is dragged', async () => {
		const { props, strip, video } = setup();
		resizeAll(320, 44);
		flushSync();
		await drawn(strip, 5);
		video.seeks = [];
		for (const end of [1.9, 1.8, 1.7, 1.6, 1.5]) {
			props.view = { start: 1, end };
			flushSync();
		}
		await drawn(strip, 5);
		// Each earlier stretch gave up at its first picture.
		expect(video.seeks.slice(-5)).toEqual([1.05, 1.15, 1.25, 1.35, 1.45]);
		expect(video.seeks.length).toBeLessThanOrEqual(10);
	});

	it('stops taking pictures and lets go of the video when it goes', async () => {
		const { opened, video, unmount } = setup();
		video.answers = false;
		resizeAll(320, 44);
		flushSync();
		await vi.waitFor(() => expect(video.seeks).toHaveLength(1));
		unmount();
		expect(opened.close).toHaveBeenCalledOnce();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(video.seeks).toHaveLength(1);
	});
});
