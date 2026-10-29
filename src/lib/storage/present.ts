/** Presentation helpers for library items. */
import type { DownloadProgress } from '$lib/download/download';
import { formatBytes } from '$lib/formats';
import type { ItemStatus, LibraryItem } from './db';

const MAX_TITLE = 160;

/**
 * A file name safe on Windows, macOS and Linux: no separators or reserved
 * characters, no control characters, no leading dots (hidden files, "..") and
 * no trailing dots or spaces (Windows strips them).
 */
export function exportFileName(item: Pick<LibraryItem, 'title' | 'formatId' | 'ext'>): string {
	const title =
		item.title
			.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
			.replace(/^\.+/, '_')
			.replace(/[. ]+$/, '')
			.slice(0, MAX_TITLE)
			.trim() || 'video';
	return `${title} [${item.formatId}].${item.ext}`;
}

export function progressLabel({ bytesDone, bytesTotal }: DownloadProgress): string {
	if (!bytesTotal) return formatBytes(bytesDone);
	const percent = Math.floor((bytesDone / bytesTotal) * 100);
	return `${percent}% · ${formatBytes(bytesDone)} of ${formatBytes(bytesTotal)}`;
}

const STATUS: Record<ItemStatus, string> = {
	downloading: 'Downloading',
	merging: 'Merging',
	paused: 'Paused',
	complete: 'Downloaded',
	failed: 'Failed'
};

export function statusLabel(status: ItemStatus): string {
	return STATUS[status];
}
