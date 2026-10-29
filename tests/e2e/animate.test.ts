import { readFileSync } from 'node:fs';
import { loadFFmpegCore } from '../helpers/ffmpeg';
import { decodeGif } from '../helpers/gif';
import { expect, test } from './fixtures';
import { ENGINE_BOOT_MS, EXTRACTION_MS, NO_OPFS, engineReady, hasOpfs } from './app';
import { recordConsoleCsp, recordCspViolations } from './csp';

const FIXTURE = readFileSync(new URL('../fixtures/media/bbf-360.webm', import.meta.url));

/**
 * The fixture's frames as FFmpeg decodes them, cropped to the top left: what
 * the GIF is checked against, decoded independently of the browser.
 */
async function fixtureFrames(width: number, height: number): Promise<Uint8ClampedArray[]> {
	const ffmpeg = await loadFFmpegCore();
	ffmpeg.FS.writeFile('/clip.webm', FIXTURE);
	const args = ['-i', '/clip.webm', '-vf', `crop=${width}:${height}:0:0`, '-pix_fmt', 'rgba'];
	expect(ffmpeg.exec('-loglevel', 'error', ...args, '-f', 'rawvideo', '/frames')).toBe(0);
	const bytes = ffmpeg.FS.readFile('/frames');
	const size = width * height * 4;
	return Array.from(
		{ length: bytes.length / size },
		(_, i) => new Uint8ClampedArray(bytes.slice(i * size, (i + 1) * size))
	);
}

/** Mean absolute difference per RGB channel. */
function difference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
	let sum = 0;
	for (let i = 0; i < a.length; i += 4) {
		sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
	}
	return sum / ((a.length / 4) * 3);
}

test.describe('an animated GIF from a video in the library', () => {
	test.describe.configure({ timeout: ENGINE_BOOT_MS + EXTRACTION_MS + 120_000 });

	test('is made of the chosen time range and crop, under the strict CSP', async ({
		page,
		request
	}) => {
		// Exercise the plain-download path (showSaveFilePicker opens a native dialog).
		await page.addInitScript(() => {
			delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
		});
		const violations = await recordCspViolations(page);
		const consoleCsp = recordConsoleCsp(page);

		// The fixture clip: 640×360, 24 numbered frames at 12 fps.
		await page.goto('/');
		test.skip(!(await hasOpfs(page)), NO_OPFS);
		await engineReady(page);
		await page.getByLabel('Video URL').fill('https://www.fixtures.test/watch');
		await page.getByRole('button', { name: 'Fetch formats' }).click();
		await page.getByRole('button', { name: 'Download format 0' }).click({ timeout: EXTRACTION_MS });
		const started = page.getByRole('region', { name: 'Downloads started here' });
		await expect(started.getByRole('listitem')).toHaveAttribute('data-status', 'complete', {
			timeout: 30_000
		});
		await page.getByRole('link', { name: 'Open the library' }).click();
		await page.getByRole('button', { name: 'Make an animated GIF from Big Buck Fixture' }).click();

		const dialog = page.getByRole('dialog', { name: 'Make an animated GIF' });
		const start = dialog.getByRole('slider', { name: 'Start' });
		const end = dialog.getByRole('slider', { name: 'End' });
		// The editor knows the clip's length once the browser has read it.
		await expect(end).toHaveAttribute('aria-valuemax', '2', { timeout: 15_000 });

		// The time range, from the keyboard: 0.5 s to 1.5 s.
		for (let i = 0; i < 5; i++) await start.press('ArrowRight');
		await end.press('End');
		for (let i = 0; i < 5; i++) await end.press('ArrowLeft');
		await expect(start).toHaveAttribute('aria-valuenow', '0.5');
		await expect(end).toHaveAttribute('aria-valuenow', '1.5');
		await expect(dialog.getByText('Length 1.0 s')).toBeVisible();

		// The crop, with the pointer: the bottom right corner dragged to the middle.
		const stage = (await dialog.locator('.stage').boundingBox())!;
		const corner = dialog.getByRole('button', {
			name: 'Resize the crop from the bottom right corner'
		});
		const handle = (await corner.boundingBox())!;
		await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
		await page.mouse.down();
		await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2, { steps: 8 });
		await page.mouse.up();
		const readout = (await dialog.getByText(/^Crop \d+ × \d+$/).textContent())!;
		const [cropWidth, cropHeight] = readout.match(/\d+/g)!.map(Number);
		// The top left quarter, give or take a screen pixel's worth.
		expect(Math.abs(cropWidth - 320)).toBeLessThanOrEqual(3);
		expect(Math.abs(cropHeight - 180)).toBeLessThanOrEqual(3);

		await dialog.getByLabel('Frame rate').selectOption({ label: '10 fps' });
		await dialog.getByLabel('Width').selectOption({ label: '640 px' });
		// Never scaled up: the GIF is the crop's size.
		await expect(
			dialog.getByText(`GIF: ${cropWidth} × ${cropHeight} px · 10 frames`)
		).toBeVisible();

		const animateWorker = page.waitForEvent('worker', (worker) =>
			worker.url().includes('animate.worker')
		);
		await dialog.getByRole('button', { name: 'Create GIF' }).click();
		// The encoder runs under the workers' header CSP: no eval, no Trusted Types policies.
		const workerCsp = (await request.get((await animateWorker).url())).headers()[
			'content-security-policy'
		];
		expect(workerCsp).toContain("script-src 'self' 'wasm-unsafe-eval'");
		expect(workerCsp).toContain("require-trusted-types-for 'script'; trusted-types 'none'");

		const result = dialog.getByRole('region', { name: 'Your GIF' });
		await expect(result).toBeVisible({ timeout: 60_000 });
		await expect(result).toContainText(`${cropWidth} × ${cropHeight} px · 10 frames · 1.0 s`);
		// The browser decodes it.
		const image = result.getByRole('img');
		await expect
			.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
			.toBe(cropWidth);

		const [download] = await Promise.all([
			page.waitForEvent('download'),
			result.getByRole('button', { name: 'Save GIF' }).click()
		]);
		expect(download.suggestedFilename()).toMatch(/^Big Buck Fixture.* \(0\.5s-1\.5s\) \[0\]\.gif$/);
		const gif = decodeGif(new Uint8Array(readFileSync((await download.path())!)));
		expect(gif).toMatchObject({ width: cropWidth, height: cropHeight, loop: 0 });
		expect(gif.frames.reduce((sum, frame) => sum + frame.delay, 0)).toBe(100);

		// Each frame is the clip's frame at its time — 0.5 s, 0.6 s … 1.4 s — so none
		// comes from outside the range. The clip has 12 frames a second; its frame
		// numbers are drawn on it, so every frame is unlike the others.
		const source = await fixtureFrames(cropWidth, cropHeight);
		expect(source).toHaveLength(24);
		let elapsed = 0; // centiseconds
		for (const frame of gif.frames) {
			const time = 0.5 + elapsed / 100;
			const differences = source.map((s) => difference(frame.canvas, s));
			const closest = differences.indexOf(Math.min(...differences));
			expect(closest, `frame at ${time.toFixed(1)} s`).toBe(Math.floor(time * 12 + 1e-6));
			// And close to it: the same part of the picture, at the same scale. (Chromium
			// lands at 2-5; browsers convert YUV to RGB a little differently from FFmpeg,
			// and a crop in the wrong place scores 40 and more.)
			expect(differences[closest], `frame at ${time.toFixed(1)} s`).toBeLessThan(20);
			elapsed += frame.delay;
		}
		expect(gif.frames).toHaveLength(10);

		expect(await violations()).toEqual([]);
		expect(consoleCsp).toEqual([]);
	});
});
