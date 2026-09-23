import { expect, type Page } from '@playwright/test';

/**
 * Time budgets for work Pyodide does. Firefox runs Python's first-time paths
 * several times slower than Chromium: on the CI image it boots in ~27 s (vs ~5 s)
 * and needs ~19 s for its first extraction (vs ~3 s); later ones take ~1 s.
 */
export const ENGINE_BOOT_MS = 120_000;
export const EXTRACTION_MS = 60_000;

export async function engineReady(page: Page): Promise<void> {
	await expect(page.locator('#engine-status')).toHaveAttribute('data-engine-state', 'ready', {
		timeout: ENGINE_BOOT_MS
	});
}

/**
 * Whether this browser gives the page an origin-private file system. Playwright's
 * WebKit build for Linux has no StorageManager at all (Safari itself has OPFS),
 * and private windows may refuse it.
 */
export async function hasOpfs(page: Page): Promise<boolean> {
	return page.evaluate(async () => {
		try {
			await navigator.storage.getDirectory();
			return true;
		} catch {
			return false;
		}
	});
}

export const NO_OPFS =
	"this browser build has no origin-private file system (Playwright's WebKit on Linux)";

export async function opfsFiles(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const names: string[] = [];
		const root = await navigator.storage.getDirectory();
		for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
			names.push(name);
		}
		return names;
	});
}
