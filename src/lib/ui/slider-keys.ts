/**
 * The keys of the timeline's sliders — the time range's ends and its tab, and
 * the zoom's ends: arrows a tenth of a second, a second with Shift or the Page
 * keys, Home and End as far as they go.
 */
import type { TimeRange } from '$lib/animate/clip';

export const STEP = 0.1;
export const BIG_STEP = 1;

type Key = Pick<KeyboardEvent, 'key' | 'shiftKey'>;

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
	duration: number
): number | undefined {
	if (key.key === 'Home') return edge === 'start' ? 0 : range.start + span;
	if (key.key === 'End') return edge === 'start' ? range.end - span : duration;
	const step = keyStep(key);
	return step === undefined ? undefined : range[edge] + step;
}

/** How far a key moves a whole range (Home and End: to the video's ends); undefined for others. */
export function moveDelta(key: Key, duration: number): number | undefined {
	if (key.key === 'Home') return -duration;
	if (key.key === 'End') return duration;
	return keyStep(key);
}
