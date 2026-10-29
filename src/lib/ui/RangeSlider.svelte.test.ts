import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { MIN_SPAN, type TimeRange } from '$lib/animate/clip';
import RangeSlider from './RangeSlider.svelte';

function setup(range: TimeRange = { start: 2, end: 5 }, duration = 10, disabled = false) {
	const changes: TimeRange[] = [];
	const onscrub = vi.fn();
	const props = $state({ range, duration, disabled, onscrub });
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
		end: screen.getByRole('slider', { name: 'End' })
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
		const { changes, start, track } = setup(undefined, undefined, true);
		await fireEvent.keyDown(start, { key: 'ArrowRight' });
		await fireEvent.pointerDown(track, { clientX: 290, button: 0, pointerId: 1 });
		await fireEvent.pointerMove(window, { clientX: 250, pointerId: 1 });
		expect(changes).toEqual([]);
		expect(start).toHaveAttribute('aria-disabled', 'true');
	});
});
