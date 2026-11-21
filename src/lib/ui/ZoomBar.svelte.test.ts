import { flushSync } from 'svelte';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { MIN_VIEW, type TimeRange } from '#lib/animate/clip.ts';
import ZoomBar from './ZoomBar.svelte';

function setup(
	view: TimeRange | null = null,
	range: TimeRange = { start: 2, end: 5 },
	duration = 10
) {
	const props = $state({ view, range, duration });
	render(ZoomBar, {
		get view() {
			return props.view;
		},
		set view(value: TimeRange | null) {
			props.view = value;
		},
		get range() {
			return props.range;
		},
		get duration() {
			return props.duration;
		}
	});
	const bar = screen.getByRole('group', { name: 'Timeline zoom' });
	// A 200 px bar: 20 px per second of a 10 s video.
	vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 200, 20));
	return {
		props,
		bar,
		from: screen.getByRole('slider', { name: 'Zoom from' }),
		to: screen.getByRole('slider', { name: 'Zoom to' }),
		stretch: bar.querySelector<HTMLElement>('.window')!
	};
}

describe('ZoomBar', () => {
	it('describes the stretch the timeline shows by two sliders: all of the video, to begin with', () => {
		const { from, to, stretch } = setup();
		expect(from).toHaveAttribute('aria-valuenow', '0');
		expect(from).toHaveAttribute('aria-valuemax', String(10 - MIN_VIEW));
		expect(to).toHaveAttribute('aria-valuenow', '10');
		expect(to).toHaveAttribute('aria-valuemin', String(MIN_VIEW));
		expect(to).toHaveAttribute('aria-valuetext', '0:10.0');
		expect(stretch.style.left).toBe('0%');
		expect(stretch.style.width).toBe('100%');
	});

	it('marks where the time range is in the whole video', () => {
		const { props, bar } = setup({ start: 4, end: 6 });
		const band = bar.querySelector<HTMLElement>('.band')!;
		expect(band.style.left).toBe('20%');
		expect(band.style.width).toBe('30%');
		props.range = { start: 7, end: 8 };
		flushSync();
		expect(band.style.left).toBe('70%');
		expect(band.style.width).toBe('10%');
	});

	it('zooms in by dragging an end, never closer than MIN_VIEW to the other', async () => {
		const { props, to, stretch } = setup();
		await fireEvent.pointerDown(to, { clientX: 300, button: 0, pointerId: 1 });
		expect(to).toHaveFocus();
		await fireEvent.pointerMove(window, { clientX: 200, pointerId: 1 });
		expect(props.view).toEqual({ start: 0, end: 5 });
		expect(stretch.style.width).toBe('50%');
		await fireEvent.pointerMove(window, { clientX: 0, pointerId: 1 });
		expect(props.view).toEqual({ start: 0, end: MIN_VIEW });
		await fireEvent.pointerUp(window, { pointerId: 1 });
		await fireEvent.pointerMove(window, { clientX: 300, pointerId: 1 });
		expect(props.view).toEqual({ start: 0, end: MIN_VIEW });
	});

	it('drags an end by as far as the pointer moves, wherever on it the press was', async () => {
		const { props, from, to } = setup();
		// Inside the stretch, 5 px before where it ends: the end follows the pointer, it never jumps to it.
		await fireEvent.pointerDown(to, { clientX: 295, button: 0, pointerId: 1 });
		await fireEvent.pointerMove(window, { clientX: 195, pointerId: 1 });
		expect(props.view).toEqual({ start: 0, end: 5 });
		await fireEvent.pointerUp(window, { pointerId: 1 });
		await fireEvent.pointerDown(from, { clientX: 105, button: 0, pointerId: 1 });
		await fireEvent.pointerMove(window, { clientX: 125, pointerId: 1 });
		expect(props.view).toEqual({ start: 1, end: 5 });
		// As far as the video goes.
		await fireEvent.pointerMove(window, { clientX: 0, pointerId: 1 });
		expect(props.view).toEqual({ start: 0, end: 5 });
		await fireEvent.pointerUp(window, { pointerId: 1 });
	});

	it('tells its handles where the stretch starts and ends', () => {
		const { props, bar } = setup();
		expect(bar.style.getPropertyValue('--from')).toBe('0%');
		expect(bar.style.getPropertyValue('--to')).toBe('100%');
		props.view = { start: 2, end: 5 };
		flushSync();
		expect(bar.style.getPropertyValue('--from')).toBe('20%');
		expect(bar.style.getPropertyValue('--to')).toBe('50%');
	});

	it('has no tab while it shows the whole video: there is nowhere to move', () => {
		setup();
		expect(screen.queryByRole('slider', { name: 'Move the zoom' })).toBeNull();
	});

	it('moves the stretch along by a tab under it, as long as before, until released', async () => {
		const { props } = setup({ start: 2, end: 4 });
		const tab = screen.getByRole('slider', { name: 'Move the zoom' });
		expect(tab).toHaveAttribute('aria-valuenow', '2');
		expect(tab).toHaveAttribute('aria-valuemin', '0');
		expect(tab).toHaveAttribute('aria-valuemax', '8');
		expect(tab).toHaveAttribute('aria-valuetext', '0:02.0 to 0:04.0');
		expect(tab.style.getPropertyValue('--middle')).toBe('30%');
		// However narrow the stretch, its tab is there to take: pressed, nothing moves yet.
		await fireEvent.pointerDown(tab, { clientX: 160, button: 0, pointerId: 1 });
		expect(tab).toHaveFocus();
		expect(props.view).toEqual({ start: 2, end: 4 });
		await fireEvent.pointerMove(window, { clientX: 200, pointerId: 1 });
		expect(props.view).toEqual({ start: 4, end: 6 });
		await fireEvent.pointerMove(window, { clientX: 400, pointerId: 1 });
		expect(props.view).toEqual({ start: 8, end: 10 });
		await fireEvent.pointerUp(window, { pointerId: 1 });
		await fireEvent.pointerMove(window, { clientX: 160, pointerId: 1 });
		expect(props.view).toEqual({ start: 8, end: 10 });
	});

	it('moves the stretch from the keyboard by its tab: tenths, seconds with Shift or Page keys, to either end', async () => {
		const { props } = setup({ start: 2, end: 4 });
		const tab = screen.getByRole('slider', { name: 'Move the zoom' });
		await fireEvent.keyDown(tab, { key: 'ArrowRight' });
		expect(props.view).toEqual({ start: 2.1, end: 4.1 });
		await fireEvent.keyDown(tab, { key: 'ArrowLeft', shiftKey: true });
		expect(props.view).toEqual({ start: 1.1, end: 3.1 });
		await fireEvent.keyDown(tab, { key: 'PageUp' });
		expect(props.view).toEqual({ start: 2.1, end: 4.1 });
		await fireEvent.keyDown(tab, { key: 'End' });
		expect(props.view).toEqual({ start: 8, end: 10 });
		await fireEvent.keyDown(tab, { key: 'Home' });
		expect(props.view).toEqual({ start: 0, end: 2 });
	});

	it('moves along the video by dragging between its ends, as long as before', async () => {
		const { props, stretch } = setup({ start: 2, end: 4 });
		expect(stretch.style.left).toBe('20%');
		expect(stretch.style.width).toBe('20%');
		await fireEvent.pointerDown(stretch, { clientX: 160, button: 0, pointerId: 1 });
		// The press is the stretch's, not the bar's: nothing moves yet.
		expect(props.view).toEqual({ start: 2, end: 4 });
		await fireEvent.pointerMove(window, { clientX: 200, pointerId: 1 });
		expect(props.view).toEqual({ start: 4, end: 6 });
		await fireEvent.pointerMove(window, { clientX: 400, pointerId: 1 });
		expect(props.view).toEqual({ start: 8, end: 10 });
		await fireEvent.pointerUp(window, { pointerId: 1 });
	});

	it('brings the nearer end to where the bar is pressed, to drag on', async () => {
		const { props, bar } = setup({ start: 2, end: 4 });
		await fireEvent.pointerDown(bar, { clientX: 280, button: 0, pointerId: 1 });
		expect(props.view).toEqual({ start: 2, end: 9 });
		await fireEvent.pointerMove(window, { clientX: 260, pointerId: 1 });
		expect(props.view).toEqual({ start: 2, end: 8 });
		await fireEvent.pointerUp(window, { pointerId: 1 });
		await fireEvent.pointerDown(bar, { clientX: 120, button: 0, pointerId: 1 });
		expect(props.view).toEqual({ start: 1, end: 8 });
		await fireEvent.pointerUp(window, { pointerId: 1 });
	});

	it('zooms in from a press anywhere while it shows the whole video: nothing to move along yet', async () => {
		const { props, stretch } = setup();
		await fireEvent.pointerDown(stretch, { clientX: 160, button: 0, pointerId: 1 });
		expect(props.view).toEqual({ start: 3, end: 10 });
		await fireEvent.pointerUp(window, { pointerId: 1 });
	});

	it('moves an end from the keyboard: tenths, seconds with Shift or Page keys, as far as it goes', async () => {
		const { props, from, to } = setup();
		await fireEvent.keyDown(from, { key: 'ArrowRight' });
		expect(props.view).toEqual({ start: 0.1, end: 10 });
		await fireEvent.keyDown(from, { key: 'ArrowUp', shiftKey: true });
		expect(props.view).toEqual({ start: 1.1, end: 10 });
		await fireEvent.keyDown(to, { key: 'PageDown' });
		expect(props.view).toEqual({ start: 1.1, end: 9 });
		await fireEvent.keyDown(to, { key: 'Home' });
		expect(props.view).toEqual({ start: 1.1, end: 1.1 + MIN_VIEW });
		await fireEvent.keyDown(to, { key: 'End' });
		await fireEvent.keyDown(from, { key: 'Home' });
		expect(props.view).toEqual({ start: 0, end: 10 });
		await fireEvent.keyDown(from, { key: 'End' });
		expect(props.view).toEqual({ start: 10 - MIN_VIEW, end: 10 });
	});

	it('shows all of a video shorter than MIN_VIEW, however it is dragged', async () => {
		const { props, to } = setup(null, { start: 0, end: 0.3 }, 0.3);
		await fireEvent.pointerDown(to, { clientX: 300, button: 0, pointerId: 1 });
		await fireEvent.pointerMove(window, { clientX: 150, pointerId: 1 });
		await fireEvent.pointerUp(window, { pointerId: 1 });
		await fireEvent.keyDown(to, { key: 'Home' });
		expect(props.view).toBeNull();
	});
});
