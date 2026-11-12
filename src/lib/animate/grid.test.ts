// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { fitGrid, frameIndex, frameMiddle, frameRate, gridReach, type FrameGrid } from './grid';

/** When picture k starts, as WebM and Matroska store it: in whole milliseconds. */
const webm = (fps: number, from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => Math.round(((from + i) * 1000) / fps) / 1000);

describe('fitGrid', () => {
	it("finds a video's frame interval through starts its container rounded", () => {
		const grid = fitGrid(webm(30, 0, 5))!;
		expect(grid.origin).toBeCloseTo(0, 3);
		expect(Math.abs(grid.interval - 1 / 30)).toBeLessThan(0.0002);
		expect(grid.span).toBe(5);
	});

	it('takes a picture reported twice as one, and steps over pictures it missed', () => {
		const grid = fitGrid([0.033, 0.033, 0.067, 0.133, 0.167, 0.233])!;
		expect(Math.abs(grid.interval - 1 / 30)).toBeLessThan(0.0002);
		expect(grid.span).toBe(6);
	});

	it('finds the interval when no two pictures shown were next to each other', () => {
		// A 60 fps video in a browser too busy to show every picture: gaps of two and three.
		const shown = [3, 5, 7, 10, 12, 15, 17, 19].map((k) => Math.round((k * 1000) / 60) / 1000);
		const grid = fitGrid(shown)!;
		expect(Math.abs(grid.interval - 1 / 60)).toBeLessThan(0.0002);
		expect(grid.span).toBe(16);
	});

	it('refuses starts that keep no steady rate', () => {
		expect(fitGrid([0, 0.031, 0.069, 0.093, 0.141, 0.162, 0.215])).toBeNull();
	});

	it('needs two pictures', () => {
		expect(fitGrid([0.5])).toBeNull();
		expect(fitGrid([])).toBeNull();
	});

	it('is refined by starts further on, numbered by the grid so far', () => {
		const near = webm(30000 / 1001, 0, 5);
		const coarse = fitGrid(near)!;
		const far = webm(30000 / 1001, gridReach(coarse) + 1, gridReach(coarse) + 2);
		const fine = fitGrid([...near, ...far], coarse)!;
		expect(fine.span).toBe(gridReach(coarse) + 2);
		expect(Math.abs(fine.interval - 1001 / 30000)).toBeLessThan(0.00005);
	});

	it('refuses further starts off the grid', () => {
		const coarse = fitGrid(webm(30, 0, 5))!;
		expect(fitGrid([...webm(30, 0, 5), 10 / 30 + 0.012], coarse)).toBeNull();
	});
});

describe('frameIndex and frameMiddle', () => {
	const grid: FrameGrid = { origin: 0.5, interval: 0.1, span: 10 };

	it('number the picture on screen at a time, and say where its middle is', () => {
		expect(frameIndex(grid, 0.5)).toBe(0);
		expect(frameIndex(grid, 0.55)).toBe(0);
		expect(frameIndex(grid, 0.61)).toBe(1);
		expect(frameIndex(grid, 0.45)).toBe(-1);
		expect(frameMiddle(grid, 1)).toBeCloseTo(0.65, 9);
		expect(frameMiddle(grid, -1)).toBeCloseTo(0.45, 9);
	});

	it('count a picture starting a hair after the time as the one there', () => {
		// Arithmetic noise, or a container's rounding: never the picture before.
		expect(frameIndex(grid, 0.6 - 1e-12)).toBe(1);
		expect(frameIndex(grid, 0.6 - 0.001)).toBe(1);
		// Further off than rounding, it is the picture before, however long pictures are.
		expect(frameIndex(grid, 0.6 - 0.005)).toBe(0);
		expect(frameIndex({ origin: 0, interval: 1 / 12, span: 5 }, 0.9)).toBe(10);
	});
});

describe('gridReach', () => {
	it('grows with the stretch the grid was fitted over', () => {
		const short = gridReach({ origin: 0, interval: 1 / 30, span: 5 });
		const long = gridReach({ origin: 0, interval: 1 / 30, span: 50 });
		expect(short).toBeGreaterThanOrEqual(5);
		expect(long / short).toBeCloseTo(10, 0);
	});
});

describe('frameRate', () => {
	it('reads the rates cameras use from a grid a little off them', () => {
		expect(frameRate({ origin: 0, interval: 1 / 29.95, span: 100 })).toBeCloseTo(29.97, 2);
		expect(frameRate({ origin: 0, interval: 1 / 30.1, span: 100 })).toBe(30);
		expect(frameRate({ origin: 0, interval: 1 / 12.05, span: 5 })).toBe(12);
		expect(frameRate({ origin: 0, interval: 1 / 23.95, span: 100 })).toBeCloseTo(23.976, 3);
	});

	it('says the whole number when the grid is too short to tell 29.97 from 30', () => {
		expect(frameRate({ origin: 0, interval: 1001 / 30000, span: 5 })).toBe(30);
		expect(frameRate({ origin: 0, interval: 1001 / 30000, span: 100 })).toBeCloseTo(29.97, 2);
		expect(frameRate({ origin: 0, interval: 1 / 30, span: 100 })).toBe(30);
	});

	it('leaves a rate near none of them as it is', () => {
		expect(frameRate({ origin: 0, interval: 1 / 7.5, span: 5 })).toBeCloseTo(7.5, 9);
	});
});
