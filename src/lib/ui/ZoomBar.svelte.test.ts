import { flushSync } from 'svelte';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { MIN_VIEW, type TimeRange } from '$lib/animate/clip';
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
