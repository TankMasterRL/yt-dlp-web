/**
 * Follow one pointer from a pointerdown until it is released. Listens on the
 * window, so a drag keeps going when the pointer leaves the element (and needs
 * no pointer capture, which jsdom lacks).
 */
export function followPointer(down: PointerEvent, onMove: (event: PointerEvent) => void): void {
	down.preventDefault();
	const id = down.pointerId;
	const move = (event: PointerEvent) => {
		if (event.pointerId === id) onMove(event);
	};
	const up = (event: PointerEvent) => {
		if (event.pointerId !== id) return;
		removeEventListener('pointermove', move);
		removeEventListener('pointerup', up);
		removeEventListener('pointercancel', up);
	};
	addEventListener('pointermove', move);
	addEventListener('pointerup', up);
	addEventListener('pointercancel', up);
}
