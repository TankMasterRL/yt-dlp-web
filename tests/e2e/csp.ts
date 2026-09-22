import type { Page } from '@playwright/test';

/**
 * Record every CSP / Trusted Types violation the page reports. Registered as an
 * init script, so it is in place before any of the app's code runs.
 */
export async function recordCspViolations(page: Page): Promise<() => Promise<string[]>> {
	await page.addInitScript(() => {
		const violations: string[] = [];
		(globalThis as unknown as { __cspViolations: string[] }).__cspViolations = violations;
		addEventListener('securitypolicyviolation', (e) => {
			violations.push(`${e.effectiveDirective}: ${e.blockedURI || '(inline)'} @ ${e.sourceFile}`);
		});
	});
	return () =>
		page.evaluate(() => (globalThis as unknown as { __cspViolations: string[] }).__cspViolations);
}
