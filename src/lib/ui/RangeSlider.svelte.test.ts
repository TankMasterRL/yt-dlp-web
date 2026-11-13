import { flushSync, createRawSnippet, type Snippet } from 'svelte';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIN_SPAN, type TimeRange } from '$lib/animate/clip';
import { FakeResizeObserver, resizeAll } from '../../../tests/helpers/resize-observer';
import RangeSlider from './RangeSlider.svelte';

function setup(
	range: TimeRange = { start: 2, end: 5 },
	duration = 10,
	disabled = false,
	extra: { fps?: number; children?: Snippet } = {}
) {
	const changes: TimeRange[] = [];
	const onscrub = vi.fn();
	const props = $state({ range, duration, disabled, onscrub, fps: extra.fps });
	render(RangeSlider, {
		get range() {
			return props.range;
		},
		set range(value: TimeRange) {
			props.range = value;
			changes.push(value);
		},
		get duration() {
			return props.duration;
		},
		get disabled() {
			return props.disabled;
		},
		get fps() {
			return props.fps;
		},
		children: extra.children,
		onscrub
	});
	const track = screen.getByRole('group', { name: 'Time range' });
	// A 200 px track: 20 px per second of a 10 s video.
	vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 200, 40));
	return {
		props,
		changes,
		onscrub,
		track,
		start: screen.getByRole('slider', { name: 'Start' }),
		end: screen.getByRole('slider', { name: 'End' }),
		tab: screen.getByRole('slider', { name: 'Move the range' })
	};
}

describe('RangeSlider', () => {
	it('describes both ends as sliders', () => {
		const { start, end } = setup();
		expect(start).toHaveAttribute('aria-valuenow', '2');
		expect(start).toHaveAttribute('aria-valuetext', '0:02.0');
		expect(start).toHaveAttribute('aria-valuemax', String(5 - MIN_SPAN));
		expect(end).toHaveAttribute('aria-valuenow', '5');
		expect(end).toHaveAttribute('aria-valuemin', String(2 + MIN_SPAN));
		expect(end).toHaveAttribute('aria-valuemax', '10');
	});

	it('moves an end with the keyboard: tenths, seconds with Shift or Page keys, to the limits', async () => {
		const { props, start, end, onscrub } = setup();
		await fireEvent.keyDown(start, { key: 'ArrowRight' });
		expect(props.range).toEqual({ start: 2.1, end: 5 });
		expect(onscrub).toHaveBeenLastCalledWith('start', 2.1);
		await fireEvent.keyDown(start, { key: 'ArrowLeft', shiftKey: true });
		expect(props.range.start).toBe(1.1);
		await fireEvent.keyDown(end, { key: 'PageUp' });
		expect(props.range.end).toBe(6);
		await fireEvent.keyDown(end, { key: 'End' });
		expect(props.range.end).toBe(10);
		await fireEvent.keyDown(start, { key: 'End' });
		expect(props.range.start).toBe(10 - MIN_SPAN);
		expect(onscrub).toHaveBeenLastCalledWith('start', 10 - MIN_SPAN);
		// Already as close as it can be: no change, nothing to show.
		onscrub.mockClear();
		await fireEvent.keyDown(end, { key: 'Home' });
		expect(props.range).toEqual({ start: 10 - MIN_SPAN, end: 10 });
		expect(onscrub).not.toHaveBeenCalled();
	});

	it('drags an end with the pointer, until released', async () => {
		const { props, end, onscrub } = setup();
		await fireEvent.pointerDown(end, { clientX: 200, button: 0, pointerId: 1 });
		await fireEvent.pointerMove(window, { clientX: 250, pointerId: 1 });
		expect(props.range).toEqual({ start: 2, end: 7.5 });
		expect(onscrub).toHaveBeenLastCalledWith('end', 7.5);
		// Past the other end: it stops just short of it.
		await fireEvent.pointerMove(window, { clientX: 100, pointerId: 1 });
		expect(props.range).toEqual({ start: 2, end: 2 + MIN_SPAN });
		await fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
		await fireEvent.pointerMove(window, { clientX: 300, pointerId: 1 });
		expect(props.range.end).toBe(2 + MIN_SPAN);
	});

	it('drags the whole selection, keeping its length', async () => {
		const { props, track } = setup();
		const selection = track.querySelector('.selection')!;
		await fireEvent.pointerDown(selection, { clientX: 170, button: 0, pointerId: 1 });
		await fireEvent.pointerMove(window, { clientX: 190, pointerId: 1 });
		expect(props.range).toEqual({ start: 3, end: 6 });
		await fireEvent.pointerMove(window, { clientX: 400, pointerId: 1 });
		expect(props.range).toEqual({ start: 7, end: 10 });
		await fireEvent.pointerUp(window, { pointerId: 1 });
	});

	it('has a tab under the middle of the range, a slider of where the range starts', async () => {
		const { props, tab } = setup();
		expect(tab).toHaveAttribute('aria-valuenow', '2');
		expect(tab).toHaveAttribute('aria-valuemin', '0');
		// As late as a 3 s range can start in a 10 s video.
		expect(tab).toHaveAttribute('aria-valuemax', '7');
		expect(tab).toHaveAttribute('aria-valuetext', '0:02.0 to 0:05.0');
		expect(tab.style.getPropertyValue('--middle')).toBe('35%');
		props.range = { start: 6, end: 10 };
		flushSync();
		expect(tab.style.getPropertyValue('--middle')).toBe('80%');
		expect(tab).toHaveAttribute('aria-valuemax', '6');
	});

	it('drags the whole range by its tab, keeping its length, until released', async () => {
		const { props, tab, onscrub } = setup();
		// Pressed where it is, the range stays: the press is the tab's, not the track's.
		await fireEvent.pointerDown(tab, { clientX: 170, button: 0, pointerId: 1 });
		expect(props.range).toEqual({ start: 2, end: 5 });
		expect(tab).toHaveFocus();
		await fireEvent.pointerMove(window, { clientX: 150, pointerId: 1 });
		expect(props.range).toEqual({ start: 1, end: 4 });
		expect(onscrub).toHaveBeenLastCalledWith('start', 1);
		// No further than the video goes, either way.
		await fireEvent.pointerMove(window, { clientX: 0, pointerId: 1 });
		expect(props.range).toEqual({ start: 0, end: 3 });
		await fireEvent.pointerMove(window, { clientX: 500, pointerId: 1 });
		expect(props.range).toEqual({ start: 7, end: 10 });
		await fireEvent.pointerUp(window, { pointerId: 1 });
		await fireEvent.pointerMove(window, { clientX: 170, pointerId: 1 });
		expect(props.range).toEqual({ start: 7, end: 10 });
	});

	it('moves the whole range from the keyboard: tenths, seconds with Shift or Page keys, to either end', async () => {
		const { props, tab, onscrub } = setup();
		await fireEvent.keyDown(tab, { key: 'ArrowRight' });
		expect(props.range).toEqual({ start: 2.1, end: 5.1 });
		expect(onscrub).toHaveBeenLastCalledWith('start', 2.1);
		await fireEvent.keyDown(tab, { key: 'ArrowLeft', shiftKey: true });
		expect(props.range).toEqual({ start: 1.1, end: 4.1 });
		await fireEvent.keyDown(tab, { key: 'PageUp' });
		expect(props.range).toEqual({ start: 2.1, end: 5.1 });
		await fireEvent.keyDown(tab, { key: 'ArrowDown' });
		expect(props.range).toEqual({ start: 2, end: 5 });
		await fireEvent.keyDown(tab, { key: 'End' });
		expect(props.range).toEqual({ start: 7, end: 10 });
		await fireEvent.keyDown(tab, { key: 'Home' });
		expect(props.range).toEqual({ start: 0, end: 3 });
		expect(onscrub).toHaveBeenLastCalledWith('start', 0);
		// Already there: no change, nothing to show.
		onscrub.mockClear();
		await fireEvent.keyDown(tab, { key: 'PageDown' });
		expect(props.range).toEqual({ start: 0, end: 3 });
		expect(onscrub).not.toHaveBeenCalled();
	});

	it('moves the nearer end to where the track is pressed', async () => {
		const { props, track } = setup();
		await fireEvent.pointerDown(track, { clientX: 290, button: 0, pointerId: 1 });
		expect(props.range).toEqual({ start: 2, end: 9.5 });
		await fireEvent.pointerUp(window, { pointerId: 1 });
		await fireEvent.pointerDown(track, { clientX: 110, button: 0, pointerId: 1 });
		expect(props.range).toEqual({ start: 0.5, end: 9.5 });
		await fireEvent.pointerUp(window, { pointerId: 1 });
	});

	it('does nothing while disabled', async () => {
		const { changes, start, tab, track } = setup(undefined, undefined, true);
		await fireEvent.keyDown(start, { key: 'ArrowRight' });
		await fireEvent.keyDown(tab, { key: 'ArrowRight' });
		await fireEvent.pointerDown(track, { clientX: 290, button: 0, pointerId: 1 });
		await fireEvent.pointerMove(window, { clientX: 250, pointerId: 1 });
		await fireEvent.pointerUp(window, { pointerId: 1 });
		await fireEvent.pointerDown(tab, { clientX: 170, button: 0, pointerId: 1 });
		await fireEvent.pointerMove(window, { clientX: 250, pointerId: 1 });
		expect(changes).toEqual([]);
		expect(start).toHaveAttribute('aria-disabled', 'true');
		expect(tab).toHaveAttribute('aria-disabled', 'true');
		expect(tab).toHaveAttribute('tabindex', '-1');
	});

	it('shows what it is given across the track, darkened outside the range', () => {
		const strip = createRawSnippet(() => ({ render: () => '<div data-testid="strip"></div>' }));
		const { track } = setup(undefined, undefined, undefined, { children: strip });
		expect(track).toContainElement(screen.getByTestId('strip'));
		const [before, after] = track.querySelectorAll<HTMLElement>('.dim');
		expect(before.style.width).toBe('20%');
		expect(after.style.left).toBe('50%');
	});

	it('darkens nothing when there is nothing behind it', () => {
		const { track } = setup();
		expect(track.querySelectorAll('.dim')).toHaveLength(0);
	});
});

describe("RangeSlider's frame marks", () => {
	afterEach(() => vi.unstubAllGlobals());

	const marks = (track: HTMLElement) => track.querySelector<HTMLElement>('.marks');

	it("mark where each of the animation's frames is taken, while they stand apart", async () => {
		vi.stubGlobal('ResizeObserver', FakeResizeObserver);
		const { props, track } = setup({ start: 2, end: 5 }, 10, false, { fps: 10 });
		// Laid out 800 px wide: 10 s at 10 fps puts frames 8 px apart.
		resizeAll(800, 44);
		flushSync();
		expect(marks(track)).toHaveAttribute('data-frames', '30');
		expect(marks(track)!.style.left).toBe('20%');
		expect(marks(track)!.style.width).toBe('30%');
		// They follow the range.
		props.range = { start: 1, end: 2 };
		flushSync();
		expect(marks(track)).toHaveAttribute('data-frames', '10');
		expect(marks(track)!.style.left).toBe('10%');
		// 30 fps: under 3 px apart, they would run together.
		props.fps = 30;
		flushSync();
		expect(marks(track)).toBeNull();
		// Wider, they stand apart again.
		resizeAll(1600, 44);
		flushSync();
		expect(marks(track)).toHaveAttribute('data-frames', '30');
	});

	it('are left out until the track is laid out', () => {
		vi.stubGlobal('ResizeObserver', FakeResizeObserver);
		const { track } = setup({ start: 2, end: 5 }, 10, false, { fps: 10 });
		expect(marks(track)).toBeNull();
	});

	it('are left out without a frame rate', () => {
		vi.stubGlobal('ResizeObserver', FakeResizeObserver);
		const { track } = setup();
		resizeAll(800, 44);
		flushSync();
		expect(marks(track)).toBeNull();
	});
});
