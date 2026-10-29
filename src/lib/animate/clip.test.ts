// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
	MAX_FRAMES,
	MIN_CROP,
	MIN_SPAN,
	animationFileName,
	defaultRange,
	dragCrop,
	frameCount,
	formatClipTime,
	frameDelays,
	frameTimes,
	fullFrame,
	moveRange,
	outputSize,
	sampleIndices,
	setRangeEdge,
	type Rect
} from './clip';

const bounds = { width: 640, height: 360 };
const crop: Rect = { x: 100, y: 50, width: 200, height: 100 };

describe('dragCrop', () => {
	it('moves the whole box, kept inside the frame', () => {
		expect(dragCrop(crop, 'move', 10, -20, bounds)).toEqual({ ...crop, x: 110, y: 30 });
		expect(dragCrop(crop, 'move', -500, 900, bounds)).toEqual({ ...crop, x: 0, y: 260 });
		expect(dragCrop(crop, 'move', 900, -900, bounds)).toEqual({ ...crop, x: 440, y: 0 });
	});

	it('resizes from an edge, moving only that edge', () => {
		expect(dragCrop(crop, 'n', 5, 10, bounds)).toEqual({ x: 100, y: 60, width: 200, height: 90 });
		expect(dragCrop(crop, 's', 5, 10, bounds)).toEqual({ x: 100, y: 50, width: 200, height: 110 });
		expect(dragCrop(crop, 'w', -30, 7, bounds)).toEqual({ x: 70, y: 50, width: 230, height: 100 });
		expect(dragCrop(crop, 'e', -30, 7, bounds)).toEqual({ x: 100, y: 50, width: 170, height: 100 });
	});

	it('resizes from a corner, moving both of its edges', () => {
		expect(dragCrop(crop, 'nw', -10, -10, bounds)).toEqual({
			x: 90,
			y: 40,
			width: 210,
			height: 110
		});
		expect(dragCrop(crop, 'ne', 10, -10, bounds)).toEqual({
			x: 100,
			y: 40,
			width: 210,
			height: 110
		});
		expect(dragCrop(crop, 'sw', -10, 10, bounds)).toEqual({
			x: 90,
			y: 50,
			width: 210,
			height: 110
		});
		expect(dragCrop(crop, 'se', 10, 10, bounds)).toEqual({
			x: 100,
			y: 50,
			width: 210,
			height: 110
		});
	});

	it('never leaves the frame', () => {
		expect(dragCrop(crop, 'nw', -999, -999, bounds)).toEqual({
			x: 0,
			y: 0,
			width: 300,
			height: 150
		});
		expect(dragCrop(crop, 'se', 999, 999, bounds)).toEqual({
			x: 100,
			y: 50,
			width: 540,
			height: 310
		});
	});

	it('never shrinks below the minimum, nor turns inside out', () => {
		expect(dragCrop(crop, 'e', -999, 0, bounds)).toEqual({ ...crop, width: MIN_CROP });
		expect(dragCrop(crop, 'w', 999, 0, bounds)).toEqual({
			...crop,
			x: 300 - MIN_CROP,
			width: MIN_CROP
		});
		expect(dragCrop(crop, 'n', 0, 999, bounds)).toEqual({
			...crop,
			y: 150 - MIN_CROP,
			height: MIN_CROP
		});
	});

	it('works in whole source pixels', () => {
		expect(dragCrop(crop, 'se', 10.4, 9.6, bounds)).toEqual({ ...crop, width: 210, height: 110 });
	});

	it('copes with a video smaller than the minimum crop', () => {
		const tiny = { width: 8, height: 6 };
		expect(dragCrop(fullFrame(tiny), 'se', -5, -5, tiny)).toEqual({ x: 0, y: 0, ...tiny });
	});
});

describe('time ranges', () => {
	it('defaults to the first five seconds, or all of a shorter video', () => {
		expect(defaultRange(60)).toEqual({ start: 0, end: 5 });
		expect(defaultRange(2)).toEqual({ start: 0, end: 2 });
	});

	it('moves one edge, kept inside the video and apart from the other', () => {
		const range = { start: 1, end: 3 };
		expect(setRangeEdge(range, 'start', 2, 10)).toEqual({ start: 2, end: 3 });
		expect(setRangeEdge(range, 'start', -1, 10)).toEqual({ start: 0, end: 3 });
		expect(setRangeEdge(range, 'start', 5, 10)).toEqual({ start: 3 - MIN_SPAN, end: 3 });
		expect(setRangeEdge(range, 'end', 12, 10)).toEqual({ start: 1, end: 10 });
		expect(setRangeEdge(range, 'end', 0, 10)).toEqual({ start: 1, end: 1 + MIN_SPAN });
	});

	it('keeps times to the millisecond, whatever the arithmetic', () => {
		expect(setRangeEdge({ start: 0.5, end: 2 }, 'start', 0.5 + 0.1, 2)).toEqual({
			start: 0.6,
			end: 2
		});
	});

	it('moves the whole range without changing its length', () => {
		const range = { start: 1, end: 3 };
		expect(moveRange(range, 2.5, 10)).toEqual({ start: 3.5, end: 5.5 });
		expect(moveRange(range, -5, 10)).toEqual({ start: 0, end: 2 });
		expect(moveRange(range, 20, 10)).toEqual({ start: 8, end: 10 });
	});
});

describe('frames', () => {
	it('samples the range at the frame rate, starting at its start', () => {
		expect(frameTimes({ start: 0.5, end: 1.5 }, 10)).toEqual([
			0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4
		]);
		expect(frameTimes({ start: 0, end: 0.05 }, 10)).toEqual([0]);
		expect(frameCount({ start: 0.5, end: 1.5 }, 10)).toBe(10);
		expect(frameCount({ start: 0, end: 0.05 }, 10)).toBe(1);
	});

	it('spreads centisecond delays so the animation keeps time', () => {
		expect(frameDelays(6, 30)).toEqual([3, 4, 3, 3, 4, 3]);
		expect(frameDelays(3, 12)).toEqual([8, 9, 8]);
		const delays = frameDelays(45, 15);
		expect(delays.reduce((a, b) => a + b)).toBe(300);
		// Browsers slow down anything under 2 cs to 10 cs.
		expect(Math.min(...frameDelays(100, 30))).toBeGreaterThanOrEqual(2);
	});

	it('picks evenly spread frames to build the palette from', () => {
		expect(sampleIndices(4, 16)).toEqual([0, 1, 2, 3]);
		expect(sampleIndices(100, 5)).toEqual([0, 25, 50, 74, 99]);
	});

	it('has a ceiling', () => {
		expect(MAX_FRAMES).toBeGreaterThanOrEqual(300);
	});
});

describe('output size', () => {
	it('scales the crop to the chosen width, keeping its shape', () => {
		expect(outputSize({ x: 0, y: 0, width: 640, height: 360 }, 480)).toEqual({
			width: 480,
			height: 270
		});
		expect(outputSize({ x: 0, y: 0, width: 333, height: 1000 }, 100)).toEqual({
			width: 100,
			height: 300
		});
	});

	it('never scales up', () => {
		expect(outputSize({ x: 10, y: 10, width: 200, height: 100 }, 480)).toEqual({
			width: 200,
			height: 100
		});
	});

	it('is at least one pixel tall', () => {
		expect(outputSize({ x: 0, y: 0, width: 1000, height: 1 }, 240)).toEqual({
			width: 240,
			height: 1
		});
	});
});

describe('labels', () => {
	it('shows clip times to the tenth of a second', () => {
		expect(formatClipTime(0)).toBe('0:00.0');
		expect(formatClipTime(1.54)).toBe('0:01.5');
		expect(formatClipTime(59.96)).toBe('1:00.0');
		expect(formatClipTime(3725.25)).toBe('1:02:05.3');
	});

	it('names the exported file after the video and the range', () => {
		expect(
			animationFileName({ title: 'Big Buck: Fixture', formatId: '0' }, { start: 0.5, end: 1.5 })
		).toBe('Big Buck_ Fixture (0.5s-1.5s) [0].gif');
		const long = animationFileName({ title: 'x'.repeat(300), formatId: '1' }, { start: 0, end: 2 });
		expect(long).toMatch(/ \(0\.0s-2\.0s\) \[1\]\.gif$/);
	});
});
