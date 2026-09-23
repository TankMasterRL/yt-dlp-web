import { expect, test, type Page } from '@playwright/test';
import { recordConsoleCsp, recordCspViolations } from './csp';

async function opfsFiles(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const names: string[] = [];
		const root = await navigator.storage.getDirectory();
		for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys())
			names.push(name);
		return names;
	});
}

test.describe('merging separate video and audio with ffmpeg.wasm', () => {
	test.describe.configure({ timeout: 180_000 });

	test('downloads both streams and remuxes them into one playable file, under the strict CSP', async ({
		page,
		request
	}) => {
		const violations = await recordCspViolations(page);
		const consoleCsp = recordConsoleCsp(page);
		const ffmpegRequests: string[] = [];
		page.on('request', (request) => {
			const { pathname } = new URL(request.url());
			if (pathname.includes('/ffmpeg/')) ffmpegRequests.push(`${request.method()} ${pathname}`);
		});

		await page.goto('/');
		await expect(page.locator('#engine-status')).toHaveAttribute('data-engine-state', 'ready', {
			timeout: 90_000
		});
		await page.getByLabel('Video URL').fill('https://www.fixtures.test/split');
		await page.getByRole('button', { name: 'Fetch formats' }).click();

		// The page offers yt-dlp's bv*+ba: the video-only and audio-only streams, merged.
		const best = page.getByRole('region', { name: /^Best quality/ });
		await expect(best).toContainText('VP8 video + Opus audio, merged into one WEBM file');
		// Until a merge starts, only a HEAD probe has asked about ffmpeg.wasm.
		expect(ffmpegRequests).toEqual(['HEAD /ffmpeg/ffmpeg-core.wasm']);

		const remuxWorker = page.waitForEvent('worker', (worker) =>
			worker.url().includes('remux.worker')
		);
		await best.getByRole('button', { name: 'Download best quality' }).click();

		// ffmpeg.wasm runs under the same header CSP as the engine: WebAssembly
		// allowed, eval not, Trusted Types with no policies at all.
		const workerCsp = (await request.get((await remuxWorker).url())).headers()[
			'content-security-policy'
		];
		expect(workerCsp).toContain("script-src 'self' 'wasm-unsafe-eval'");
		expect(workerCsp).not.toContain("'unsafe-eval'");
		expect(workerCsp).toContain("require-trusted-types-for 'script'; trusted-types 'none'");
		const started = page.getByRole('region', { name: 'Downloads started here' });
		await expect(started.getByRole('listitem')).toHaveAttribute('data-status', 'complete', {
			timeout: 60_000
		});
		expect(ffmpegRequests).toEqual(
			expect.arrayContaining(['GET /ffmpeg/ffmpeg-core.js', 'GET /ffmpeg/ffmpeg-core.wasm'])
		);

		// One library item, one OPFS file: the parts are gone once merged.
		await page.getByRole('link', { name: 'Open the library' }).click();
		const card = page.getByRole('article', { name: /^Split Stream Fixture/ });
		await expect(card).toHaveAttribute('data-status', 'complete');
		const files = await opfsFiles(page);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^[\w-]+\.webm$/);

		// The WebM's track list names both streams…
		const head = await page.evaluate(async (name) => {
			const root = await navigator.storage.getDirectory();
			const file = await (await root.getFileHandle(name)).getFile();
			return new TextDecoder('latin1').decode(await file.slice(0, 4096).arrayBuffer());
		}, files[0]);
		expect(head).toContain('V_VP8');
		expect(head).toContain('A_OPUS');

		// …and the browser decodes both: picture and sound.
		await card.getByRole('button', { name: /^Play / }).click();
		const video = page.getByRole('dialog').locator('video');
		await expect
			.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15_000 })
			.toBe(640);
		await video.evaluate((v: HTMLVideoElement) => {
			v.muted = true;
			return v.play();
		});
		await expect
			.poll(
				() =>
					video.evaluate(
						(v: HTMLVideoElement) =>
							(v as HTMLVideoElement & { webkitAudioDecodedByteCount: number })
								.webkitAudioDecodedByteCount
					),
				{ timeout: 15_000 }
			)
			.toBeGreaterThan(0);

		expect(await violations()).toEqual([]);
		expect(consoleCsp).toEqual([]);
	});
});
