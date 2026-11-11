import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { Rect } from '$lib/animate/clip';
import CropBox from './CropBox.svelte';

const bounds = { width: 640, height: 360 };

function setup(crop: Rect = { x: 160, y: 90, width: 320, height: 180 }, disabled = false) {
	const props = $state({ crop, disabled });
	const changes: Rect[] = [];
	const { container } = render(CropBox, {
		get crop() {
			return props.crop;
		},
		set crop(value: Rect) {
			props.crop = value;
			changes.push(value);
		},
		bounds,
		get disabled() {
			return props.disabled;
		}
	});
	const overlay = container.querySelector<HTMLElement>('.overlay')!;
	// Shown at half size: one screen pixel is two video pixels.
	vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 180));
	return { props, changes, box: container.querySelector<HTMLElement>('.box')! };
}

const control = (name: string) => screen.getByRole('button', { name });

describe('CropBox', () => {
	it('frames the crop, in proportion to the picture', () => {
		const { box } = setup();
		expect(box.style.left).toBe('25%');
		expect(box.style.top).toBe('25%');
		expect(box.style.width).toBe('50%');
		expect(box.style.height).toBe('50%');
	});

	it('offers the box and all eight edges and corners', () => {
		setup();
		for (const name of [
			'Move the crop',
			'Resize the crop from the top',
			'Resize the crop from the top right corner',
			'Resize the crop from the right',
			'Resize the crop from the bottom right corner',
			'Resize the crop from the bottom',
			'Resize the crop from the bottom left corner',
			'Resize the crop from the left',
			'Resize the crop from the top left corner'
		]) {
			expect(control(name)).toBeInTheDocument();
		}
	});

	it('resizes and moves with the arrow keys, in bigger steps with Shift', async () => {
		const { props } = setup();
		await fireEvent.keyDown(control('Resize the crop from the right'), { key: 'ArrowRight' });
		expect(props.crop).toEqual({ x: 160, y: 90, width: 326, height: 180 });
		await fireEvent.keyDown(control('Resize the crop from the top'), {
			key: 'ArrowUp',
			shiftKey: true
		});
		expect(props.crop).toEqual({ x: 160, y: 30, width: 326, height: 240 });
		await fireEvent.keyDown(control('Move the crop'), { key: 'ArrowLeft' });
		expect(props.crop).toEqual({ x: 154, y: 30, width: 326, height: 240 });
	});

	it('drags a corner, in video pixels', async () => {
		const { props } = setup();
		const corner = control('Resize the crop from the bottom right corner');
		await fireEvent.pointerDown(corner, { clientX: 240, clientY: 135, button: 0, pointerId: 7 });
		await fireEvent.pointerMove(window, { clientX: 250, clientY: 130, pointerId: 7 });
		expect(props.crop).toEqual({ x: 160, y: 90, width: 340, height: 170 });
		await fireEvent.pointerUp(window, { pointerId: 7 });
		await fireEvent.pointerMove(window, { clientX: 300, clientY: 170, pointerId: 7 });
		expect(props.crop.width).toBe(340);
	});

	it('drags the whole box, never out of the picture', async () => {
		const { props } = setup();
		const move = control('Move the crop');
		await fireEvent.pointerDown(move, { clientX: 160, clientY: 90, button: 0, pointerId: 1 });
		await fireEvent.pointerMove(window, { clientX: 140, clientY: 95, pointerId: 1 });
		expect(props.crop).toEqual({ x: 120, y: 100, width: 320, height: 180 });
		await fireEvent.pointerMove(window, { clientX: 999, clientY: -999, pointerId: 1 });
		expect(props.crop).toEqual({ x: 320, y: 0, width: 320, height: 180 });
		await fireEvent.pointerUp(window, { pointerId: 1 });
	});

	it('does nothing while disabled', async () => {
		const { changes } = setup(undefined, true);
		await fireEvent.keyDown(control('Move the crop'), { key: 'ArrowLeft' });
		const corner = control('Resize the crop from the top left corner');
		await fireEvent.pointerDown(corner, { clientX: 80, clientY: 45, button: 0, pointerId: 1 });
		await fireEvent.pointerMove(window, { clientX: 10, clientY: 10, pointerId: 1 });
		expect(changes).toEqual([]);
		expect(corner).toBeDisabled();
	});
});
