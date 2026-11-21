/** Presentation helpers for library items. */
import type { DownloadProgress } from '#lib/download/download.ts';
import { formatBytes } from '#lib/formats.ts';
import type { ItemStatus, LibraryItem } from './db';

const MAX_TITLE = 160;

/**
 * A file name safe on Windows, macOS and Linux: no separators or reserved
 * characters, no control characters, no leading dots (hidden files, "..") and
 * no trailing dots or spaces (Windows strips them). Downloads are tagged with
 * their format, `<title> [<format>].<ext>`; imported files have none.
 */
export function exportFileName(item: { title: string; formatId?: string; ext: string }): string {
	const title =
		item.title
			.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
			.replace(/^\.+/, '_')
			.replace(/[. ]+$/, '')
			.slice(0, MAX_TITLE)
			.trim() || 'video';
	return item.formatId ? `${title} [${item.formatId}].${item.ext}` : `${title}.${item.ext}`;
}

export function progressLabel({ bytesDone, bytesTotal }: DownloadProgress): string {
	if (!bytesTotal) return formatBytes(bytesDone);
	const percent = Math.floor((bytesDone / bytesTotal) * 100);
	return `${percent}% · ${formatBytes(bytesDone)} of ${formatBytes(bytesTotal)}`;
}

const STATUS: Record<ItemStatus, string> = {
	downloading: 'Downloading',
	merging: 'Merging',
	importing: 'Importing',
	paused: 'Paused',
	complete: 'Downloaded',
	failed: 'Failed'
};

/**
 * The bytes the library itself keeps in this browser: each item's file (as
 * much of it as is written, live while it runs) and its thumbnail. The storage
 * meter shows this, not the browser's estimate for the whole origin, which
 * counts everything else the site's address keeps too — other apps served from
 * the same origin (localhost, github.io), and storage the app doesn't manage.
 */
export function libraryBytes(
	items: readonly LibraryItem[],
	live: Readonly<Record<string, DownloadProgress>>
): number {
	return items.reduce((sum, item) => {
		const written =
			item.status === 'complete'
				? (item.bytesTotal ?? item.bytesDone)
				: (live[item.id]?.bytesDone ?? item.bytesDone);
		return sum + written + (item.thumbnail?.size ?? 0);
	}, 0);
}

/**
 * The quota Brave reports to every site, on every platform, whatever the site
 * stores and whatever Brave would let it store (brave-core#6622, so that the
 * figure cannot tell sites or private windows apart). Its `usage` is real.
 */
export const BRAVE_QUOTA = 2 ** 31;

/**
 * How much more the browser says this site may store, from its estimate — or
 * null where the estimate says nothing of it: no quota, Brave's fixed one, or
 * one the site has already gone past, which cannot be a limit it is held to.
 * (Chromium's is usage + 10 GiB by design, so there it is always 10 GiB.)
 */
export function storageRoom({ usage = 0, quota = 0 }: StorageEstimate): number | null {
	if (!quota || quota === BRAVE_QUOTA || usage > quota) return null;
	return quota - usage;
}

/** An item's status in words; a finished import was imported, not downloaded. */
export function statusLabel(status: ItemStatus, origin?: LibraryItem['origin']): string {
	return status === 'complete' && origin === 'import' ? 'Imported' : STATUS[status];
}
