/**
 * Regenerate docs/screenshot.png, the README's picture of the app, from the
 * real built app and the e2e fixture site (no internet involved):
 *
 *   bun run screenshot
 *
 * Builds with VITE_RELAY_URL pointing at the fixture relay, serves the build and
 * the relay as e2e does, fetches the split-stream fixture's formats and captures
 * the page. Re-run it after any change to how the app looks, and commit the PNG
 * with that change.
 */
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const APP = 'http://localhost:4173';
const RELAY = 'http://localhost:4174';
const env = { ...process.env, VITE_RELAY_URL: RELAY };

async function waitFor(url: string, ms = 60_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (
			await fetch(url).then(
				() => true,
				() => false
			)
		)
			return;
		await Bun.sleep(250);
	}
	throw new Error(`${url} did not come up within ${ms / 1000} s`);
}

const build = Bun.spawnSync(['bun', 'run', 'build'], {
	cwd: root,
	env,
	stdout: 'inherit',
	stderr: 'inherit'
});
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

const servers = [
	Bun.spawn(['bun', 'scripts/fixture-relay.ts'], { cwd: root, env, stdout: 'ignore' }),
	// vite itself, not `bun run preview`, which reports the kill below as a failure.
	Bun.spawn([`${root}node_modules/.bin/vite`, 'preview', '--port', '4173', '--strictPort'], {
		cwd: root,
		env,
		stdout: 'ignore'
	})
];
const prebuilt = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch(existsSync(prebuilt) ? { executablePath: prebuilt } : {});
try {
	await Promise.all([waitFor(APP), waitFor(`${RELAY}/solve`)]);
	const page = await browser.newPage({
		viewport: { width: 1100, height: 800 },
		deviceScaleFactor: 2,
		colorScheme: 'light'
	});
	await page.goto(APP);
	await page.locator('#engine-status[data-engine-state="ready"]').waitFor({ timeout: 120_000 });
	await page.getByLabel('Video URL').fill('https://www.fixtures.test/split');
	await page.getByRole('button', { name: 'Fetch formats' }).click();
	await page.getByRole('region', { name: /^Best quality/ }).waitFor({ timeout: 60_000 });
	// The log collapses once yt-dlp is done; leave it that way.
	await page.screenshot({ path: `${root}docs/screenshot.png`, fullPage: true });
	console.log('✓ wrote docs/screenshot.png');
} finally {
	await browser.close();
	for (const server of servers) server.kill();
}
