/**
 * A ResizeObserver for jsdom, which has none (and lays nothing out): install
 * it with `vi.stubGlobal('ResizeObserver', FakeResizeObserver)`, then say how
 * big the observed elements are with `resizeAll`.
 */
export class FakeResizeObserver {
	static active = new Set<FakeResizeObserver>();
	readonly targets = new Set<Element>();

	constructor(readonly callback: ResizeObserverCallback) {}

	observe(target: Element): void {
		this.targets.add(target);
		FakeResizeObserver.active.add(this);
	}

	unobserve(target: Element): void {
		this.targets.delete(target);
	}

	disconnect(): void {
		this.targets.clear();
		FakeResizeObserver.active.delete(this);
	}
}

/** Every observed element is now `width` × `height` CSS pixels (content box). */
export function resizeAll(width: number, height: number): void {
	for (const observer of FakeResizeObserver.active) {
		const entries = [...observer.targets].map(
			(target) => ({ target, contentRect: new DOMRect(0, 0, width, height) }) as ResizeObserverEntry
		);
		observer.callback(entries, observer as unknown as ResizeObserver);
	}
}
