import type { Attachment } from 'svelte/attachments';

/**
 * Shows `blob` in an image by a blob: URL of its own (CSP img-src blob:),
 * revoked once the image goes or shows another: a URL left alive keeps the
 * Blob's bytes for as long as the page is open.
 */
export function objectUrl(blob: Blob): Attachment<HTMLImageElement> {
	return (image) => {
		const url = URL.createObjectURL(blob);
		image.src = url;
		return () => URL.revokeObjectURL(url);
	};
}
