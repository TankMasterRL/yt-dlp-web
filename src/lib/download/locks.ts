/** Web Lock names held by the download worker while an item downloads. */
const PREFIX = 'yt-dlp-web:download:';

export function downloadLockName(itemId: string): string {
	return `${PREFIX}${itemId}`;
}

/** Item ids any tab is downloading right now. */
export async function activeDownloads(locks: LockManager = navigator.locks): Promise<Set<string>> {
	const { held = [] } = await locks.query();
	return new Set(
		held
			.map((lock) => lock.name ?? '')
			.filter((name) => name.startsWith(PREFIX))
			.map((name) => name.slice(PREFIX.length))
	);
}
