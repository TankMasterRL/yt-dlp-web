import { expect, test } from './fixtures';
import { headersFor, securityHeaderRules } from '../../csp.config.js';
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

test('pages and assets carry the security headers a real deploy sends', async ({ request }) => {
	// The same rules build/_headers and deploy/Caddyfile are generated from.
	const rules = securityHeaderRules({ relayOrigin: 'http://localhost:4174' });
	for (const path of ['/', '/library/', '/favicon.svg', '/pyodide/pyodide.mjs']) {
		const headers = (await request.get(path)).headers();
		for (const [name, value] of Object.entries(headersFor(path, rules))) {
			expect(headers[name.toLowerCase()], `${name} on ${path}`).toBe(value);
		}
	}
	const home = (await request.get('/')).headers();
	expect(home['content-security-policy']).toContain("frame-ancestors 'none'");
	expect(home['x-frame-options']).toBe('DENY');
	expect(home['cross-origin-opener-policy']).toBe('same-origin');
	// Nothing here needs SharedArrayBuffer, so no cross-origin isolation.
	expect(home).not.toHaveProperty('cross-origin-embedder-policy');
});

test('refuses to be framed', async ({ page }) => {
	// Judged from outside the frame: Firefox under Playwright 1.64 never
	// answers a locator that enters a frame the browser blocked. A framed app
	// that rendered would fetch its own scripts before the parent's load event;
	// a blocked one fetches its document and nothing else.
	const requested: string[] = [];
	page.on('request', (request) => requested.push(new URL(request.url()).pathname));
	await page.setContent('<iframe src="http://localhost:4173/" title="app"></iframe>', {
		waitUntil: 'load'
	});
	expect(requested).toEqual(['/']);
});

test('every feature the Permissions-Policy switches off is one the browser knows', async ({
	page
}) => {
	const complaints: string[] = [];
	page.on('console', (message) => {
		if (/Permissions-Policy|Permissions Policy/i.test(message.text()))
			complaints.push(message.text());
	});
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1, name: 'Download' })).toBeVisible();
	expect(complaints).toEqual([]);
});
