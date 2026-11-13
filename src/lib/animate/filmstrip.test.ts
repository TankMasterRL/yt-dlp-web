// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { FakeVideo } from '../../../tests/helpers/video';
import { MAX_TILES, drawTiles, tileCount, tileSize, tileTimes, type TileCanvas } from './filmstrip';
import type { SeekableVideo } from './frames';

/**
 * A canvas that notes, for each picture drawn on it, the time of the one on
 * screen and where it went — and how it was smoothed, in `smoothing`.
 */
function fakeCanvas(video: FakeVideo, width = 78, height = 44) {
	const draws: number[][] = [];
	const smoothing: string[] = [];
	const context = {
		imageSmoothingEnabled: false,
		imageSmoothingQuality: 'low' as ImageSmoothingQuality,
		drawImage(_image: CanvasImageSource, ...at: number[]) {
			draws.push([video.shown, ...at]);
			smoothing.push(context.imageSmoothingEnabled ? context.imageSmoothingQuality : 'none');
		}
	};
	const canvas: TileCanvas & { draws: number[][]; smoothing: string[] } = {
		width,
		height,
		draws,
		smoothing,
		getContext: () => context
	};
	return canvas;
}

const asVideo = (video: FakeVideo) => video as unknown as SeekableVideo & CanvasImageSource;

describe('the frame timeline', () => {
	it("fills the strip with pictures of the video's shape, as many as fit", () => {
		// 16:9 pictures 44 px tall are 78 px wide: 11 of them cover 800 px, the last one cropped.
		expect(tileCount({ width: 800, height: 44 }, 16 / 9)).toBe(11);
		expect(tileCount({ width: 330, height: 44 }, 16 / 9)).toBe(5);
		expect(tileCount({ width: 78, height: 44 }, 16 / 9)).toBe(1);
		// A tall video's pictures are narrow: never more than a strip's worth of seeks.
		expect(tileCount({ width: 1600, height: 44 }, 9 / 16)).toBe(MAX_TILES);
		// Not laid out (yet): nothing to show.
		expect(tileCount({ width: 0, height: 44 }, 16 / 9)).toBe(0);
		expect(tileCount({ width: 800, height: 0 }, 16 / 9)).toBe(0);
	});

	it('shows each stretch of the video by the picture in its middle', () => {
		expect(tileTimes({ start: 0, end: 2 }, 4)).toEqual([0.25, 0.75, 1.25, 1.75]);
		// Microseconds, as media elements count.
		expect(tileTimes({ start: 0, end: 10 }, 3)).toEqual([1.666667, 5, 8.333333]);
		expect(tileTimes({ start: 0, end: 2 }, 0)).toEqual([]);
	});

	it('shows only the stretch the timeline is zoomed in on', () => {
		expect(tileTimes({ start: 1, end: 1.5 }, 5)).toEqual([1.05, 1.15, 1.25, 1.35, 1.45]);
	});

	it("draws each picture at the strip's height in device pixels, in the video's shape", () => {
		expect(tileSize(44, 16 / 9, 1)).toEqual({ width: 78, height: 44 });
		expect(tileSize(44, 16 / 9, 2)).toEqual({ width: 156, height: 88 });
		expect(tileSize(44, 4 / 3, 1.5)).toEqual({ width: 88, height: 66 });
		expect(tileSize(0.2, 16 / 9, 1)).toEqual({ width: 2, height: 1 });
	});
});

describe('drawTiles', () => {
	it('seeks to each picture in turn and draws the whole of it on its tile', async () => {
		const video = new FakeVideo();
		const tiles = [0.25, 0.75, 1.25].map((time) => ({ time, canvas: fakeCanvas(video) }));
		const drawn: number[] = [];
		await drawTiles(asVideo(video), tiles, (i) => drawn.push(i));
		expect(video.seeks).toEqual([0.25, 0.75, 1.25]);
		expect(tiles.map((tile) => tile.canvas.draws)).toEqual([
			[[0.25, 0, 0, 78, 44]],
			[[0.75, 0, 0, 78, 44]],
			[[1.25, 0, 0, 78, 44]]
		]);
		expect(drawn).toEqual([0, 1, 2]);
	});

	it('shrinks the picture smoothly: lines and lettering stay legible', async () => {
		const video = new FakeVideo();
		const canvas = fakeCanvas(video);
		await drawTiles(asVideo(video), [{ time: 0.5, canvas }]);
		expect(canvas.smoothing).toEqual(['high']);
	});

	it('waits for the video to know its length before seeking', async () => {
		const video = new FakeVideo();
		video.readyState = 0;
		const canvas = fakeCanvas(video);
		const drawing = drawTiles(asVideo(video), [{ time: 0.5, canvas }]);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(video.seeks).toEqual([]);
		video.readyState = 1;
		video.dispatchEvent(new Event('loadedmetadata'));
		await drawing;
		expect(canvas.draws).toEqual([[0.5, 0, 0, 78, 44]]);
	});

	it('stops where it is when told to', async () => {
		const video = new FakeVideo();
		video.answers = false;
		const tiles = [0.25, 0.75].map((time) => ({ time, canvas: fakeCanvas(video) }));
		const stop = new AbortController();
		const drawing = drawTiles(asVideo(video), tiles, undefined, stop.signal);
		await new Promise((resolve) => setTimeout(resolve, 5));
		stop.abort(new DOMException('', 'AbortError'));
		await expect(drawing).rejects.toMatchObject({ name: 'AbortError' });
		expect(video.seeks).toEqual([0.25]);
		expect(tiles[0].canvas.draws).toEqual([]);
	});

	it('fails as the video does', async () => {
		const video = new FakeVideo();
		video.answers = false;
		const drawing = drawTiles(asVideo(video), [{ time: 0.5, canvas: fakeCanvas(video) }]);
		await new Promise((resolve) => setTimeout(resolve, 5));
		video.fail(3);
		await expect(drawing).rejects.toThrow('The browser could not decode this video');
	});
});
