import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { recordCspViolations } from './csp';

const FIXTURE = readFileSync(new URL('../fixtures/media/bbf-360.webm', import.meta.url));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function opfsFiles(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const names: string[] = [];
		const root = await navigator.storage.getDirectory();
		for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys())
			names.push(name);
		return names;
	});
}

test.describe('download → library → play → export → delete', () => {
	test.describe.configure({ timeout: 150_000 });

	test('a download survives the whole journey byte for byte', async ({ page }) => {
		// Exercise the plain-download export path (showSaveFilePicker opens a
		// native dialog automation cannot drive).
		await page.addInitScript(() => {
			delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
		});
		const violations = await recordCspViolations(page);

		// Extract the fake page and download its 360p format.
		await page.goto('/');
		await expect(page.locator('#engine-status')).toHaveAttribute('data-engine-state', 'ready', {
			timeout: 90_000
		});
		await page.getByLabel('Video URL').fill('https://www.fixtures.test/watch');
		await page.getByRole('button', { name: 'Fetch formats' }).click();
		await page.getByRole('button', { name: 'Download format 0' }).click();
		const started = page.getByRole('region', { name: 'Downloads started here' });
		await expect(started.getByRole('listitem')).toHaveAttribute('data-status', 'complete', {
			timeout: 30_000
		});

		// It is in the library, stored in OPFS.
		await page.getByRole('link', { name: 'Open the library' }).click();
		const card = page.getByRole('article', { name: /^Big Buck Fixture/ });
		await expect(card).toHaveAttribute('data-status', 'complete');
		expect(await opfsFiles(page)).toHaveLength(1);

		// It plays: the browser decodes the stored bytes.
		await card.getByRole('button', { name: /^Play / }).click();
		const video = page.getByRole('dialog').locator('video');
		await expect
			.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15_000 })
			.toBe(640);
		await page.getByRole('button', { name: 'Close player' }).click();

		// Export: the saved file is bit-identical to what the "site" served.
		const [download] = await Promise.all([
			page.waitForEvent('download'),
			card.getByRole('button', { name: /^Save / }).click()
		]);
		expect(download.suggestedFilename()).toBe('Big Buck Fixture (1) [0].webm');
		const exported = readFileSync((await download.path())!);
		expect(sha256(exported)).toBe(sha256(FIXTURE));

		// It survives a reload (IndexedDB metadata, OPFS bytes).
		await page.reload();
		await expect(page.getByRole('article', { name: /^Big Buck Fixture/ })).toHaveAttribute(
			'data-status',
			'complete'
		);

		// Delete asks once, then removes the record and the bytes.
		await page.getByRole('button', { name: /^Delete Big Buck Fixture/ }).click();
		await page.getByRole('button', { name: /^Confirm deleting/ }).click();
		await expect(page.getByRole('article')).toHaveCount(0);
		await expect(page.getByText('Nothing here yet.')).toBeVisible();
		expect(await opfsFiles(page)).toEqual([]);

		expect(await violations()).toEqual([]);
	});
});
