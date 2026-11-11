/**
 * A build without a relay (VITE_RELAY_URL=none): the gate's last run builds
 * the app that way for this spec alone. In a build with a relay it skips.
 */
import { NO_RELAY } from '../../src/lib/relay/protocol';
import { expect, test } from './fixtures';
import { NO_OPFS } from './app';
import { recordConsoleCsp, recordCspViolations } from './csp';
import { animateFromDisk, importJourney, withoutSavePicker } from './device';

test.describe('a build without a relay', () => {
	test.skip(
		process.env.VITE_RELAY_URL !== NO_RELAY,
		'this build has a relay: run with VITE_RELAY_URL=none'
	);
	test.describe.configure({ timeout: 180_000 });

	test('says it fetches nothing, starts no engine, ships none, and connects nowhere else', async ({
		page,
		request
	}) => {
		const violations = await recordCspViolations(page);
		const requests: string[] = [];
		page.on('request', (r) => requests.push(r.url()));

		await page.goto('/');
		const notice = page.locator('[data-relay="none"]');
		await expect(notice).toContainText('This site has no relay');
		await expect(page.getByLabel('Video URL')).toHaveCount(0);
		await expect(page.locator('#engine-status')).toHaveCount(0);

		// The page may connect to its own origin only.
		const csp = await page
			.locator('meta[http-equiv="content-security-policy"]')
			.getAttribute('content');
		expect(csp).toMatch(/connect-src 'self';/);
		// Neither the engine nor FFmpeg is shipped.
		expect((await request.get('/pyodide/pyodide.mjs')).status()).toBe(404);
		expect((await request.get('/ffmpeg/ffmpeg-core.wasm')).status()).toBe(404);

		await notice.getByRole('link', { name: 'import videos you already have' }).click();
		await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
		await expect(page.getByText('Nothing here yet. Import videos you already have')).toBeVisible();

		const own = new URL(page.url()).origin;
		const elsewhere = requests.filter((url) => /^https?:/.test(url) && !url.startsWith(own));
		expect(elsewhere).toEqual([]);
		expect(requests.filter((url) => url.includes('/pyodide/') || url.includes('/wheels/'))).toEqual(
			[]
		);
		expect(await violations()).toEqual([]);
	});

	test('imports, plays, saves and animates videos from the device', async ({ page }) => {
		const violations = await recordCspViolations(page);
		const consoleCsp = recordConsoleCsp(page);
		await withoutSavePicker(page);
		test.skip(!(await importJourney(page)), NO_OPFS);
		expect(await violations()).toEqual([]);
		expect(consoleCsp).toEqual([]);
	});

	test('animates a video straight from disk', async ({ page }) => {
		await withoutSavePicker(page);
		await animateFromDisk(page);
	});
});
