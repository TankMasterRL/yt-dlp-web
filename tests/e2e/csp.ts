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

/**
 * What `recordCspViolations` records for the `<style>body {}</style>` Playwright's
 * WebKit appends to the page before every screenshot, whatever the options, to sync
 * its animations (`WKPage.shouldToggleStyleSheetToSyncAnimations`): the app's
 * `style-src` refuses it, and it has no source file. Chromium and Firefox add none.
 */
export const SCREENSHOT_STYLE = 'style-src-elem: inline @ ';

/** The page's own violations, in a spec that takes screenshots: all but those of its screenshots. */
export const ownViolations = (violations: string[]): string[] =>
	violations.filter((violation) => violation !== SCREENSHOT_STYLE);

/** CSP / Trusted Types violations inside workers only reach the console. */
export function recordConsoleCsp(page: Page): string[] {
	const messages: string[] = [];
	page.on('console', (message) => {
		if (/Content Security Policy|Trusted Type/i.test(message.text())) messages.push(message.text());
	});
	return messages;
}
