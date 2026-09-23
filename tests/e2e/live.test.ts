import { expect, test } from '@playwright/test';

/**
 * Real YouTube, through a DEPLOYED app and relay Worker — the only test that
 * leaves the hermetic sandbox. Excluded unless LIVE_APP_URL is set, e.g.
 *
 *   LIVE_APP_URL=https://tankmasterrl.github.io/yt-dlp-web/ bunx playwright test --grep @live
 *
 * youtube.com is unreachable from the Claude Code web sandbox, so it always
 * skips there. Big Buck Bunny is the Blender Foundation's own CC-BY upload.
 */
const LIVE_APP_URL = process.env.LIVE_APP_URL;
const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

test.describe('@live real YouTube via a deployed relay', () => {
	test.skip(!LIVE_APP_URL, 'set LIVE_APP_URL to a deployed app to run @live tests');
	test.describe.configure({ timeout: 180_000 });

	test('extracts a real YouTube video, solving its JS challenges in the sandbox', async ({
		page
	}) => {
		await page.goto(LIVE_APP_URL!);
		await expect(page.locator('#engine-status')).toHaveAttribute('data-engine-state', 'ready', {
			timeout: 120_000
		});
		await page.getByLabel('Video URL').fill(VIDEO);
		await page.getByRole('button', { name: 'Fetch formats' }).click();

		await expect(page.getByRole('heading', { level: 2 })).toContainText('Big Buck Bunny', {
			timeout: 120_000
		});
		await expect(page.getByText('Video + audio').first()).toBeVisible();
		// On a deployment with a Worker Loader, n challenges are solved by the
		// sandbox: no "challenge solving failed" warnings in yt-dlp's log.
		if (await page.locator('[data-solver="unavailable"]').isHidden()) {
			await page.getByText(/^yt-dlp log/).click();
			await expect(page.getByRole('list', { name: 'yt-dlp log' })).not.toContainText(
				/challenge solving failed|Error solving n challenge/i
			);
		}
	});
});
