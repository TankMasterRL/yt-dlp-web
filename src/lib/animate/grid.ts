/**
 * Where a video's pictures start, as a grid: picture k is on screen from
 * origin + k·interval seconds until the next one starts. Frames for an
 * animation are taken from the middle of grid pictures, never at the times
 * the animation's own frames fall on.
 *
 * Those times are where trouble is. A frame of an animation at a video's own
 * rate (or a whole fraction of it) falls exactly where a picture starts, and
 * containers round when pictures start: WebM and Matroska count whole
 * milliseconds, so at 30 fps picture 2 starts at 67 ms, after 2/30 s, and a seek
 * to 2/30 s shows picture 1. Which side of the edge a seek lands on is then
 * down to the rounding: 30 fps taken from a 30 fps WebM came out as pictures
 * 0, 1, 1, 3, 4, 4, … — every third one twice, the next one lost — in Chromium,
 * Firefox and WebKit alike. In the middle of a picture, half an interval from
 * either edge, no rounding can tip a seek over.
 *
 * Pure: the starts come from the browser (frames.ts reads them off a moment of
 * playback, the only time every engine reports them).
 */

export interface FrameGrid {
	/** When picture 0 starts, in seconds: one of the pictures it was fitted to. */
	origin: number;
	/** Seconds from one picture to the next. */
	interval: number;
	/** How many intervals the starts it was fitted to covered, which is how far it can be trusted. */
	span: number;
}

/** Where pictures start, without how far that was measured: all stepping through them needs. */
export type PictureGrid = Pick<FrameGrid, 'origin' | 'interval'>;

/** Starts closer than this are one picture reported twice. */
const SAME_PICTURE = 0.00025;
/** A start may be off by half a millisecond either way (WebM's rounding): an interval, by twice that. */
const ROUNDING = 0.001;
/** Pictures shorter than this are not believed (1000 fps). */
const MIN_INTERVAL = 0.001;
/**
 * A picture starting this soon after a time is the one on screen there (at
 * most a quarter of an interval): a container's rounding, not a picture later.
 */
const HAIR = 0.002;
/** Rates cameras use that are not whole numbers: NTSC's, 1000/1001 of 24, 30, 60 and 120. */
const NTSC_RATES = [24, 30, 60, 120].map((rate) => (rate * 1000) / 1001);
/** How far off a measured rate may be from a common one and still be it. */
const RATE_TOLERANCE = 0.015;

/**
 * The grid through `starts` (when pictures started, in any order), or null if
 * they are too few or keep no steady rate. With `seed`, the starts are numbered
 * by it — for starts further on than a grid of their own could number.
 */
export function fitGrid(starts: readonly number[], seed?: FrameGrid): FrameGrid | null {
	const times = [...starts]
		.sort((a, b) => a - b)
		.filter((time, i, all) => i === 0 || time - all[i - 1] > SAME_PICTURE);
	if (times.length < 2) return null;
	const guess = seed ?? { origin: times[0], interval: commonInterval(times) };
	if (guess.interval < MIN_INTERVAL) return null;
	const numbers = times.map((time) => Math.round((time - guess.origin) / guess.interval));
	if (new Set(numbers).size !== numbers.length) return null;
	// Numbered right: each within a quarter interval of the guess's line.
	if (!onGrid(times, numbers, guess, 4)) return null;

	// The least-squares line through (number, start): every start counts, so the
	// rounding of any one of them hardly does.
	const count = times.length;
	const meanN = numbers.reduce((sum, n) => sum + n, 0) / count;
	const meanT = times.reduce((sum, t) => sum + t, 0) / count;
	let covariance = 0;
	let variance = 0;
	for (let i = 0; i < count; i++) {
		covariance += (numbers[i] - meanN) * (times[i] - meanT);
		variance += (numbers[i] - meanN) ** 2;
	}
	const interval = covariance / variance;
	const fitted = {
		origin: meanT - interval * meanN,
		interval,
		span: Math.max(...numbers) - Math.min(...numbers)
	};
	// Steady: each within an eighth of the fitted line (a steady video's are within its
	// container's rounding, half a millisecond).
	return interval >= MIN_INTERVAL && onGrid(times, numbers, fitted, 8) ? fitted : null;
}

/**
 * The longest interval every gap between `times` is a whole number of: the
 * shortest gap, or a half, third or quarter of it — a browser that cannot keep
 * up skips pictures, and may never show two neighbours (gaps of 2, 3, 2, …).
 */
function commonInterval(times: number[]): number {
	const gaps = times.slice(1).map((time, i) => time - times[i]);
	const shortest = Math.min(...gaps);
	for (let parts = 1; parts <= 4; parts++) {
		const interval = shortest / parts;
		const whole = (gap: number) => Math.abs(gap / interval - Math.round(gap / interval)) <= 0.2;
		if (gaps.every(whole)) return interval;
	}
	return shortest;
}

/** Whether every start is within 1/`parts` of an interval of its line on `grid`. */
function onGrid(
	times: number[],
	numbers: number[],
	grid: Omit<FrameGrid, 'span'>,
	parts: number
): boolean {
	return times.every(
		(time, i) => Math.abs(time - grid.origin - numbers[i] * grid.interval) <= grid.interval / parts
	);
}

/** How far a picture may start after a time and count as there, in seconds. */
const hair = (grid: PictureGrid) => Math.min(HAIR, grid.interval / 4);

/**
 * How many pictures either side of its origin the grid can be trusted to:
 * its interval is off by at most the rounding over its span, so its error
 * grows with the distance — and stays within a hair this far (never more than
 * an eighth of a picture, so a seek to a middle lands in that picture).
 */
export function gridReach(grid: FrameGrid): number {
	const error = Math.min(hair(grid), grid.interval / 8);
	return Math.max(grid.span, Math.floor((grid.span * error) / ROUNDING));
}

/** The number of the picture on screen at `time`: one starting a hair later counts as there. */
export function frameIndex(grid: PictureGrid, time: number): number {
	return Math.floor((time - grid.origin + hair(grid)) / grid.interval);
}

/**
 * The grid to step through a video's pictures by: at `fps`, the rate its fitted
 * `grid` was read as (exact, where the fit is a little off it), through the
 * picture start nearest the video's beginning, kept to the millisecond as
 * containers keep starts.
 */
export function stepGrid(grid: FrameGrid, fps: number): PictureGrid {
	const interval = 1 / fps;
	const phase = grid.origin - Math.round(grid.origin / interval) * interval;
	// `|| 0`: never -0.
	return { origin: Math.round(phase * 1000) / 1000 || 0, interval };
}

/**
 * Where the picture `steps` pictures on from the one on screen at `time` starts
 * (back, for negative steps): the arrow keys move the time range's ends a
 * picture at a time. Numbered, not added up, so starts kept to the millisecond
 * never drift off the pictures, and a step from mid-picture is still one.
 */
export function stepFrame(grid: PictureGrid, time: number, steps: number): number {
	return grid.origin + (frameIndex(grid, time) + steps) * grid.interval;
}

/** The middle of picture `index`: half an interval from either edge, where a seek is sure to land on it. */
export function frameMiddle(grid: PictureGrid, index: number): number {
	return grid.origin + (index + 0.5) * grid.interval;
}

/**
 * Where to seek to show the picture on screen at `time`: its middle. The time
 * range's ends sit where pictures start, and a seek to a start may show the
 * picture before it (WebKit does, for WebM's millisecond starts).
 */
export function pictureMiddle(grid: PictureGrid, time: number): number {
	return frameMiddle(grid, frameIndex(grid, time));
}

/**
 * Pictures per second: the common rate it is, when it is near one (30, 29.97,
 * 12), else as measured. A whole number unless the grid is long enough to rule
 * it out: 29.97 and 30 are a tenth of a percent apart, and a few pictures'
 * rounding is more.
 */
export function frameRate(grid: FrameGrid): number {
	const measured = 1 / grid.interval;
	/** How far off the measurement may be, in frames per second. */
	const uncertainty = (measured * ROUNDING) / (grid.span * grid.interval);
	const near = (rate: number, within: number) => Math.abs(rate - measured) <= within;
	const whole = Math.round(measured);
	if (whole > 0 && near(whole, uncertainty)) return whole;
	const [nearest] = [whole, ...NTSC_RATES]
		.filter((rate) => rate > 0)
		.sort((a, b) => Math.abs(a - measured) - Math.abs(b - measured));
	return nearest !== undefined && near(nearest, measured * RATE_TOLERANCE) ? nearest : measured;
}
