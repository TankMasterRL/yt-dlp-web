import { expect, test } from './fixtures';
import { ENGINE_BOOT_MS, EXTRACTION_MS, engineReady } from './app';
import { recordConsoleCsp, recordCspViolations } from './csp';

test.describe('extraction in a real browser worker', () => {
	test.describe.configure({ timeout: ENGINE_BOOT_MS + 2 * EXTRACTION_MS });

	test('yt-dlp extracts formats through the relay, under the strict CSP', async ({
		page,
		request
	}) => {
		const consoleCsp = recordConsoleCsp(page);
		const violations = await recordCspViolations(page);
		const workerStarted = page.waitForEvent('worker');
		await page.goto('/');
		await engineReady(page);
		await expect(page.locator('#engine-status')).toContainText(/yt-dlp \d{4}\.\d+\.\d+ ready/);

		// The engine really runs under the header CSP self-hosted deploys send
		// to workers: WebAssembly allowed, eval not, Trusted Types with no policies.
		const worker = await workerStarted;
		const workerCsp = (await request.get(worker.url())).headers()['content-security-policy'];
		expect(workerCsp).toContain("script-src 'self' 'wasm-unsafe-eval'");
		expect(workerCsp).not.toContain("'unsafe-eval'");
		expect(workerCsp).toContain("require-trusted-types-for 'script'; trusted-types 'none'");

		// The fixture relay has no Worker Loader (like a Free-plan deploy): the UI
		// says so, and yt-dlp is told the challenge solver is unavailable.
		await expect(page.locator('[data-solver="unavailable"]')).toBeVisible();

		await page.getByLabel('Video URL').fill('https://www.fixtures.test/watch');
		await page.getByRole('button', { name: 'Fetch formats' }).click();

		await expect(page.getByRole('heading', { level: 2 })).toHaveText(/^Big Buck Fixture/, {
			timeout: EXTRACTION_MS
		});
		// Header row + one row per <source>.
		await expect(page.getByRole('row')).toHaveCount(3);
		await expect(page.getByText('recommended')).toBeVisible();
		// The log collapses once yt-dlp finishes; expand it as a person would.
		await page.getByText(/^yt-dlp log/).click();
		await expect(page.getByRole('list', { name: 'yt-dlp log' })).toContainText('[generic]');

		expect(await violations()).toEqual([]);
		expect(consoleCsp).toEqual([]);
	});

	test('follows a redirect hop by hop through the relay', async ({ page }) => {
		await page.goto('/');
		await engineReady(page);
		await page.getByLabel('Video URL').fill('https://www.fixtures.test/moved');
		await page.getByRole('button', { name: 'Fetch formats' }).click();
		await expect(page.getByRole('heading', { level: 2 })).toHaveText(/^Big Buck Fixture/, {
			timeout: EXTRACTION_MS
		});
	});

	test('reports a host the relay refuses', async ({ page }) => {
		await page.goto('/');
		await engineReady(page);
		await page.getByLabel('Video URL').fill('https://example.com/video');
		await page.getByRole('button', { name: 'Fetch formats' }).click();
		await expect(page.getByRole('alert')).toContainText(
			/relay refused \(403\): host not on the allowlist/,
			{ timeout: EXTRACTION_MS }
		);
	});
});

test('a relay that does not answer this page is named, and the library is pointed to', async ({
	page
}) => {
	test.setTimeout(ENGINE_BOOT_MS);
	// The same app from an origin the fixture relay does not admit (it admits
	// http://localhost:4173): to this page, the relay is as good as switched off.
	await page.goto('http://127.0.0.1:4173/');
	const note = page.locator('[data-relay="unreachable"]');
	await expect(note).toContainText("The relay at localhost:4174 isn't answering this page", {
		timeout: ENGINE_BOOT_MS
	});
	// Not mistaken for a relay without a Worker Loader.
	await expect(page.locator('[data-solver="unavailable"]')).toHaveCount(0);
	await note.getByRole('link', { name: 'imported into the library' }).click();
	await expect(page.getByRole('button', { name: 'Import videos…' })).toBeVisible();
});
