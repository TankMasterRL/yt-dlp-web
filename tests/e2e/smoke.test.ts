import { expect, test } from '@playwright/test';
import { recordCspViolations } from './csp';

test('the app shell loads under the strict CSP without a single violation', async ({ page }) => {
	const violations = await recordCspViolations(page);
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1, name: 'Download' })).toBeVisible();

	await page.getByRole('link', { name: 'Library' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();

	expect(await violations()).toEqual([]);
});

test('the prerendered page ships a strict, Trusted-Types-enforcing CSP', async ({ request }) => {
	const html = await (await request.get('/')).text();
	const csp = html.match(/<meta http-equiv="content-security-policy" content="([^"]+)"/)?.[1];
	expect(csp, 'CSP meta tag').toBeTruthy();
	expect(csp).toContain("default-src 'none'");
	expect(csp).toContain("'wasm-unsafe-eval'");
	expect(csp).not.toContain("'unsafe-eval'");
	expect(csp).toContain("require-trusted-types-for 'script'");
	expect(csp).toMatch(/trusted-types [^;]*svelte-trusted-html/);
	expect(csp).toContain("object-src 'none'");
	expect(csp).toContain("base-uri 'none'");
});
