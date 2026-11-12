import type { Attachment } from 'svelte/attachments';
import type { Size } from '$lib/animate/clip';

/**
 * An attachment that reports its element's size (the content box, in CSS
 * pixels) once it is laid out, and again whenever that changes. Where there
 * is no ResizeObserver (jsdom), it never does.
 */
export function observeSize(onsize: (size: Size) => void): Attachment<Element> {
	return (node) => {
		if (typeof ResizeObserver !== 'function') return;
		const observer = new ResizeObserver((entries) => {
			for (const { contentRect } of entries)
				onsize({ width: contentRect.width, height: contentRect.height });
		});
		observer.observe(node);
		return () => observer.disconnect();
	};
}
