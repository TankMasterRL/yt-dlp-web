/**
 * `test` and `expect` for every spec. Plain Playwright, plus the BrowserOS
 * project (playwright.config.ts): BrowserOS is a Chromium fork that runs only on
 * developers' machines, never in CI.
 *
 * - BROWSEROS_PATH: Playwright launches that executable, like any Chromium.
 * - BROWSEROS_CDP_URL: attach to a BrowserOS that is already running, started
 *   with `--remote-debugging-port=9222` (e.g. http://127.0.0.1:9222). Each test
 *   still gets a fresh context, so the running profile is never touched.
 * - Neither: the project's tests skip.
 */
import { expect, test as base, type Browser } from '@playwright/test';

export { expect };

const cdpUrl = process.env.BROWSEROS_CDP_URL;
export const BROWSEROS_CONFIGURED = Boolean(process.env.BROWSEROS_PATH || cdpUrl);

const withBrowserOS = base.extend<{ browserOSConfigured: void }>({
	browserOSConfigured: [
		async ({}, use, testInfo) => {
			testInfo.skip(
				testInfo.project.name === 'browseros' && !BROWSEROS_CONFIGURED,
				'BrowserOS is not configured: set BROWSEROS_PATH or BROWSEROS_CDP_URL'
			);
			await use();
		},
		{ auto: true }
	]
});

export const test = cdpUrl
	? withBrowserOS.extend<object, { browser: Browser }>({
			browser: [
				async ({ playwright, browserName, headless, launchOptions }, use, workerInfo) => {
					const browser =
						workerInfo.project.name === 'browseros'
							? await playwright.chromium.connectOverCDP(cdpUrl)
							: await playwright[browserName].launch({ ...launchOptions, headless });
					await use(browser);
					// For an attached BrowserOS this only disconnects; it keeps running.
					await browser.close();
				},
				{ scope: 'worker' }
			]
		})
	: withBrowserOS;
