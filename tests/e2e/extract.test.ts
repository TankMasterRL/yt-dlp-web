import { expect, test, type Page } from '@playwright/test';
import { recordCspViolations } from './csp';

/** CSP / Trusted Types violations inside workers only reach the console. */
function recordConsoleCsp(page: Page): string[] {
	const messages: string[] = [];
	page.on('console', (message) => {
		if (/Content Security Policy|Trusted Type/i.test(message.text())) messages.push(message.text());
	});
	return messages;
}

async function engineReady(page: Page) {
	await expect(page.locator('#engine-status')).toHaveAttribute('data-engine-state', 'ready', {
		timeout: 90_000
	});
}

test.describe('extraction in a real browser worker', () => {
	test.describe.configure({ timeout: 120_000 });

	test('yt-dlp extracts formats through the relay, under the strict CSP', async ({ page, request }) => {
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

		await page.getByLabel('Video URL').fill('https://www.fixtures.test/watch');
		await page.getByRole('button', { name: 'Fetch formats' }).click();

		await expect(page.getByRole('heading', { level: 2 })).toHaveText(/^Big Buck Fixture/);
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
		await expect(page.getByRole('heading', { level: 2 })).toHaveText(/^Big Buck Fixture/);
	});

	test('reports a host the relay refuses', async ({ page }) => {
		await page.goto('/');
		await engineReady(page);
		await page.getByLabel('Video URL').fill('https://example.com/video');
		await page.getByRole('button', { name: 'Fetch formats' }).click();
		await expect(page.getByRole('alert')).toContainText(/relay refused \(403\): host not on the allowlist/);
	});
});
