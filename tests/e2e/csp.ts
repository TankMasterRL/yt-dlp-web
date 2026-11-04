import type { Page } from '@playwright/test';
import { probe } from './app';

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
		probe('read the CSP violations the page recorded', () =>
			page.evaluate(() => (globalThis as unknown as { __cspViolations: string[] }).__cspViolations)
		);
}

/** CSP / Trusted Types violations inside workers only reach the console. */
export function recordConsoleCsp(page: Page): string[] {
	const messages: string[] = [];
	page.on('console', (message) => {
		if (/Content Security Policy|Trusted Type/i.test(message.text())) messages.push(message.text());
	});
	return messages;
}
