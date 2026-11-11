import { expect, test } from './fixtures';
import { NO_OPFS, hasOpfs, opfsFiles } from './app';
import { recordConsoleCsp, recordCspViolations } from './csp';
import { animateFromDisk, importJourney, pickFiles, withoutSavePicker } from './device';

test.describe('videos already on this device', () => {
	test.describe.configure({ timeout: 180_000 });

	test('an imported video is stored, played, saved back byte for byte, animated and deleted, under the strict CSP', async ({
		page
	}) => {
		const violations = await recordCspViolations(page);
		const consoleCsp = recordConsoleCsp(page);
		await withoutSavePicker(page);
		const relayed: string[] = [];
		page.on('request', (request) => {
			if (new URL(request.url()).port === '4174') relayed.push(request.url());
		});

		test.skip(!(await importJourney(page)), NO_OPFS);

		// Nothing went through the relay: the file came from the device, and so did its thumbnail.
		expect(relayed).toEqual([]);
		expect(await violations()).toEqual([]);
		expect(consoleCsp).toEqual([]);
	});

	test('a video opened straight from disk becomes an animated image, and nothing is copied', async ({
		page
	}) => {
		const violations = await recordCspViolations(page);
		await withoutSavePicker(page);
		await animateFromDisk(page);
		expect(await violations()).toEqual([]);
	});

	test('a file the browser cannot play is refused, and nothing is stored', async ({ page }) => {
		await page.goto('/library/');
		test.skip(!(await hasOpfs(page)), NO_OPFS);
		await pickFiles(page, 'Import videos…', [
			{ name: 'notes.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not a video at all') }
		]);
		await expect(page.getByRole('alert')).toContainText("notes.mp4 wasn't imported", {
			timeout: 30_000
		});
		await expect(page.getByRole('article')).toHaveCount(0);
		expect(await opfsFiles(page)).toEqual([]);
	});

	test('without private file storage, nothing can be imported — but a file can still be animated', async ({
		page
	}) => {
		// As in a private window that refuses OPFS (or an engine without it).
		await withoutSavePicker(page);
		await page.addInitScript(() => {
			const storage = globalThis.StorageManager?.prototype as
				{ getDirectory?: unknown } | undefined;
			if (storage)
				storage.getDirectory = () => Promise.reject(new DOMException('denied', 'SecurityError'));
		});
		await page.goto('/library/');
		await expect(page.locator('[data-storage="unavailable"]')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Import videos…' })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Animate a video file…' })).toBeEnabled();
		await animateFromDisk(page);
	});
});
