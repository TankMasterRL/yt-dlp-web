/**
 * The keys of the timeline's sliders — the time range's ends and its tab, and
 * the zoom's ends: arrows a tenth of a second, a second with Shift or the Page
 * keys, Home and End as far as they go. Given where the video's pictures start
 * (the time range, once the video's frame rate is known), the arrows step one
 * picture instead.
 */
import type { TimeRange } from '$lib/animate/clip';
import { stepFrame, type PictureGrid } from '$lib/animate/grid';

export const STEP = 0.1;
export const BIG_STEP = 1;

type Key = Pick<KeyboardEvent, 'key' | 'shiftKey'>;

const ARROWS: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };

/** Where an arrow key without Shift takes `time` on `pictures`; undefined for other keys, or none. */
function pictureStep({ key, shiftKey }: Key, time: number, pictures: PictureGrid | null) {
	const steps = ARROWS[key];
	return pictures && !shiftKey && steps ? stepFrame(pictures, time, steps) : undefined;
}

/** How far an arrow or Page key moves a slider; undefined for any other key. */
function keyStep({ key, shiftKey }: Key): number | undefined {
	const step = shiftKey ? BIG_STEP : STEP;
	const steps: Record<string, number> = {
		ArrowLeft: -step,
		ArrowDown: -step,
		ArrowRight: step,
		ArrowUp: step,
		PageDown: -BIG_STEP,
		PageUp: BIG_STEP
	};
	return steps[key];
}

/**
 * Where a key sends one end of `range`, whose ends stay `span` apart in a
 * video `duration` long; undefined for keys a slider leaves alone.
 */
export function edgeTarget(
	key: Key,
	range: TimeRange,
	edge: 'start' | 'end',
	span: number,
	duration: number,
	pictures: PictureGrid | null = null
): number | undefined {
	if (key.key === 'Home') return edge === 'start' ? 0 : range.start + span;
	if (key.key === 'End') return edge === 'start' ? range.end - span : duration;
	const picture = pictureStep(key, range[edge], pictures);
	if (picture !== undefined) return picture;
	const step = keyStep(key);
	return step === undefined ? undefined : range[edge] + step;
}

/**
 * How far a key moves a whole range starting at `start` (Home and End: to the
 * video's ends; the arrows, on `pictures`, to the next or previous picture's
 * start); undefined for keys a slider leaves alone.
 */
export function moveDelta(
	key: Key,
	start: number,
	duration: number,
	pictures: PictureGrid | null = null
): number | undefined {
	if (key.key === 'Home') return -duration;
	if (key.key === 'End') return duration;
	const picture = pictureStep(key, start, pictures);
	return picture !== undefined ? picture - start : keyStep(key);
}
