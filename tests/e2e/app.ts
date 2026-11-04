import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';

/**
 * Time budgets for work Pyodide does. Firefox runs Python's first-time paths
 * several times slower than Chromium: on the CI image it boots in ~27 s (vs ~5 s)
 * and needs ~19 s for its first extraction (vs ~3 s); later ones take ~1 s.
 */
export const ENGINE_BOOT_MS = 120_000;
export const EXTRACTION_MS = 60_000;

/** How long a probe may take: page.evaluate and download.path() have no timeout of their own. */
export const PROBE_MS = 30_000;

/**
 * Run a wait Playwright leaves unbounded (page.evaluate, a locator's evaluate,
 * download.path()) as a named step with a timeout, so a probe that never
 * answers fails as itself instead of as the test's timeout, with no step named.
 */
export function probe<T>(title: string, body: () => Promise<T>): Promise<T> {
	return test.step(title, body, { timeout: PROBE_MS });
}

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
	return probe('ask whether the page has an origin-private file system', () =>
		page.evaluate(async () => {
			try {
				await navigator.storage.getDirectory();
				return true;
			} catch {
				return false;
			}
		})
	);
}

export const NO_OPFS =
	"this browser build has no origin-private file system (Playwright's WebKit on Linux)";

export async function opfsFiles(page: Page): Promise<string[]> {
	return probe('list the files in OPFS', () =>
		page.evaluate(async () => {
			const names: string[] = [];
			const root = await navigator.storage.getDirectory();
			for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
				names.push(name);
			}
			return names;
		})
	);
}
