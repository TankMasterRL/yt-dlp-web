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
			launchOptions: chromiumPath ? { executablePath: chromiumPath } : {}
		}
	}
];
if (browsers.includes('firefox')) projects.push({ name: 'firefox', use: devices['Desktop Firefox'] });
if (browsers.includes('webkit')) projects.push({ name: 'webkit', use: devices['Desktop Safari'] });

export default defineConfig({
	testDir: 'tests/e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? 'list' : 'html',
	use: {
		baseURL: 'http://localhost:4173',
		trace: 'on-first-retry'
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
