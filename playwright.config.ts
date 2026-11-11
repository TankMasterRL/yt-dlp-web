import { existsSync } from 'node:fs';
import { defineConfig, devices, type Project } from '@playwright/test';

// The remote environment ships a prebuilt Chromium at /opt/pw-browsers; use it
// when present so we never download a browser there. Elsewhere (e.g. CI's
// Dockerfile.test image) fall back to Playwright's own installed browsers.
const prebuilt = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const chromiumPath = existsSync(prebuilt) ? prebuilt : undefined;

// Chromium always; Firefox and WebKit where their builds exist (CI sets
// E2E_BROWSERS=chromium,firefox,webkit inside the Playwright image).
const browsers = (process.env.E2E_BROWSERS ?? 'chromium').split(',').map((b) => b.trim());

const projects: Project[] = [
	{
		name: 'chromium',
		use: {
			...devices['Desktop Chrome'],
			launchOptions: {
				...(chromiumPath ? { executablePath: chromiumPath } : {}),
				// Chromium's JPEG XL decoder is still behind a flag: with it, e2e checks the
				// app's JPEG XL output in a real browser too. Nothing else depends on it.
				args: ['--enable-features=JXLImageFormat']
			}
		}
	}
];
if (browsers.includes('firefox'))
	projects.push({ name: 'firefox', use: devices['Desktop Firefox'] });
if (browsers.includes('webkit')) projects.push({ name: 'webkit', use: devices['Desktop Safari'] });

// BrowserOS, a Chromium fork: developers' machines only, never CI. `bun run
// test:browseros` (which sets BROWSEROS=1) launches BROWSEROS_PATH, or attaches
// to a running instance at BROWSEROS_CDP_URL (tests/e2e/fixtures.ts); with
// neither, its tests skip.
const browserOSPath = process.env.BROWSEROS_PATH;
if (process.env.BROWSEROS || browserOSPath || process.env.BROWSEROS_CDP_URL) {
	projects.push({
		name: 'browseros',
		use: {
			...devices['Desktop Chrome'],
			launchOptions: browserOSPath ? { executablePath: browserOSPath } : {}
		}
	});
}

export default defineConfig({
	testDir: 'tests/e2e',
	// @live tests hit real YouTube through a deployed app; run them with LIVE_APP_URL set.
	grepInvert: process.env.LIVE_APP_URL ? undefined : /@live/,
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? 'list' : 'html',
	use: {
		baseURL: 'http://localhost:4173',
		// Nothing waits forever: a stuck step fails as itself, not as the test's timeout.
		actionTimeout: 30_000,
		navigationTimeout: 60_000,
		// CI keeps a trace of every failed attempt, the first included: a failure
		// that passes on retry is still one to explain.
		trace: process.env.CI ? 'retain-on-failure' : 'on-first-retry'
	},
	projects,
	webServer: [
		// The real relay handler with a fake video site as its upstream.
		{
			command: 'bun scripts/fixture-relay.ts',
			port: 4174,
			reuseExistingServer: !process.env.CI
		},
		{
			command: 'bun run build && bun run preview --port 4173 --strictPort',
			port: 4173,
			env: { VITE_RELAY_URL: 'http://localhost:4174' },
			reuseExistingServer: !process.env.CI,
			timeout: 180_000
		}
	]
});
