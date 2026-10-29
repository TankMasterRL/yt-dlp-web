/**
 * The geometry and timing of an animated image cut from a video: which part
 * of the frame (the crop, in the video's own pixels), which stretch of time
 * (the range, in seconds), how many frames at which delays, and how big.
 * Pure, so the editor, the crop handles and the time slider share one set of
 * rules.
 */
import type { LibraryItem } from '$lib/storage/db';
import { exportFileName } from '$lib/storage/present';
import { FORMATS, type AnimationFormat } from './formats';

/** A region of the video frame, in whole source pixels. */
export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface Size {
	width: number;
	height: number;
}

/** Seconds into the video; frames are taken from `start` up to, not including, `end`. */
export interface TimeRange {
	start: number;
	end: number;
}

/** What a crop drag holds: the box itself, or one of its edges or corners. */
export type CropHandle = 'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

/** The smallest crop, per side, in source pixels (or the whole side of a smaller video). */
export const MIN_CROP = 16;
/** The shortest range, in seconds. */
export const MIN_SPAN = 0.1;
/** A new editor starts with this much of the video. */
export const DEFAULT_SPAN = 5;
/**
 * Frames are grabbed one seek at a time, and a GIF of more is rarely wanted:
 * 20 s at 30 fps, a minute at 10.
 */
export const MAX_FRAMES = 600;
/**
 * At most 30: GIF delays are whole centiseconds, and browsers slow anything
 * under 2 cs down to 10.
 */
export const FPS_CHOICES = [5, 10, 12, 15, 20, 25, 30] as const;
export const WIDTH_CHOICES = [160, 240, 320, 480, 640, 800] as const;
/** Frames the palette is built from, spread over the range. */
export const PALETTE_SAMPLES = 16;

export function fullFrame({ width, height }: Size): Rect {
	return { x: 0, y: 0, width, height };
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const ms = (seconds: number) => Math.round(seconds * 1000) / 1000;

/**
 * `crop` with `handle` dragged by (dx, dy) source pixels: an edge moves only
 * itself, a corner its two edges, `move` the whole box. The result stays inside
 * `bounds` and never gets smaller than MIN_CROP a side.
 */
export function dragCrop(
	crop: Rect,
	handle: CropHandle,
	dx: number,
	dy: number,
	bounds: Size
): Rect {
	const [x, y] = [Math.round(dx), Math.round(dy)];
	if (handle === 'move') {
		return {
			...crop,
			x: clamp(crop.x + x, 0, bounds.width - crop.width),
			y: clamp(crop.y + y, 0, bounds.height - crop.height)
		};
	}
	const minWidth = Math.min(MIN_CROP, bounds.width);
	const minHeight = Math.min(MIN_CROP, bounds.height);
	let [left, top] = [crop.x, crop.y];
	let [right, bottom] = [crop.x + crop.width, crop.y + crop.height];
	if (handle.includes('w')) left = clamp(left + x, 0, right - minWidth);
	if (handle.includes('e')) right = clamp(right + x, left + minWidth, bounds.width);
	if (handle.includes('n')) top = clamp(top + y, 0, bottom - minHeight);
	if (handle.includes('s')) bottom = clamp(bottom + y, top + minHeight, bounds.height);
	return { x: left, y: top, width: right - left, height: bottom - top };
}

export function defaultRange(duration: number): TimeRange {
	return { start: 0, end: ms(Math.min(duration, DEFAULT_SPAN)) };
}

/** `range` with one edge moved to `time`, inside the video and at least MIN_SPAN long. */
export function setRangeEdge(
	range: TimeRange,
	edge: 'start' | 'end',
	time: number,
	duration: number
): TimeRange {
	const span = Math.min(MIN_SPAN, duration);
	return edge === 'start'
		? { start: ms(clamp(time, 0, range.end - span)), end: range.end }
		: { start: range.start, end: ms(clamp(time, range.start + span, duration)) };
}

/** `range` shifted by `delta` seconds, as far as the video allows, its length kept. */
export function moveRange(range: TimeRange, delta: number, duration: number): TimeRange {
	const length = range.end - range.start;
	const start = ms(clamp(range.start + delta, 0, duration - length));
	return { start, end: ms(start + length) };
}

/** How many frames `range` makes at `fps`: at least one. */
export function frameCount({ start, end }: TimeRange, fps: number): number {
	return Math.max(1, Math.round((end - start) * fps));
}

/** When each frame is taken: every 1/fps seconds from the range's start. */
export function frameTimes(range: TimeRange, fps: number): number[] {
	// Microseconds, as media elements count: no 0.30000000000000004 s seeks.
	return Array.from(
		{ length: frameCount(range, fps) },
		(_, i) => Math.round((range.start + i / fps) * 1e6) / 1e6
	);
}

/**
 * Frame `index`'s delay in units of 1/`perSecond` s (GIF counts centiseconds,
 * WebP milliseconds). 1/fps is rarely a whole number of them, so the rounding
 * error is carried along (30 fps in centiseconds: 3, 4, 3 …) and the
 * animation runs as long as the range.
 */
export function delayAt(index: number, fps: number, perSecond: number): number {
	const at = (i: number) => Math.round((i * perSecond) / fps);
	return at(index + 1) - at(index);
}

/** The first `count` frames' delays in centiseconds, GIF's unit. */
export function frameDelays(count: number, fps: number): number[] {
	return Array.from({ length: count }, (_, i) => delayAt(i, fps, 100));
}

/** Up to `max` indices into `count` frames, evenly spread, first and last included. */
export function sampleIndices(count: number, max: number): number[] {
	if (count <= max) return Array.from({ length: count }, (_, i) => i);
	return Array.from({ length: max }, (_, i) => Math.round((i * (count - 1)) / (max - 1)));
}

/** The crop scaled to `width` (never up), its shape kept. */
export function outputSize(crop: Rect, width: number): Size {
	const w = Math.min(width, crop.width);
	return { width: w, height: Math.max(1, Math.round((crop.height * w) / crop.width)) };
}

/** 1.54 → '0:01.5'; 3725.25 → '1:02:05.3'. */
export function formatClipTime(seconds: number): string {
	const tenths = Math.round(seconds * 10);
	const h = Math.floor(tenths / 36000);
	const m = Math.floor((tenths % 36000) / 600);
	const s = ((tenths % 600) / 10).toFixed(1).padStart(4, '0');
	return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** 'Title (0.5s-1.5s) [formatId].gif', the range kept even for the longest titles. */
export function animationFileName(
	item: Pick<LibraryItem, 'title' | 'formatId'>,
	{ start, end }: TimeRange,
	format: AnimationFormat
): string {
	const title = `${item.title.slice(0, 140)} (${start.toFixed(1)}s-${end.toFixed(1)}s)`;
	return exportFileName({ title, formatId: item.formatId, ext: FORMATS[format].ext });
}
