import { expect, test } from './fixtures';
import { ENGINE_BOOT_MS, EXTRACTION_MS, NO_OPFS, engineReady, hasOpfs, opfsFiles } from './app';
import { recordConsoleCsp, recordCspViolations } from './csp';

/** Whether a media element has sound, asked in each engine's own terms. */
function hasAudio(element: HTMLVideoElement): boolean {
	const media = element as HTMLVideoElement & {
		mozHasAudio?: boolean;
		audioTracks?: { length: number };
		webkitAudioDecodedByteCount?: number;
	};
	if (media.mozHasAudio !== undefined) return media.mozHasAudio; // Firefox
	if (media.audioTracks) return media.audioTracks.length > 0; // WebKit
	return (media.webkitAudioDecodedByteCount ?? 0) > 0; // Chromium, once decoding runs
}

// Runs with the FFmpeg core the build ships: ffmpeg.wasm, or (YT_DLP_WEB_FFMPEG=remux) the remux core.
test.describe('merging separate video and audio with FFmpeg', () => {
	test.describe.configure({ timeout: ENGINE_BOOT_MS + EXTRACTION_MS + 120_000 });

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
		test.skip(!(await hasOpfs(page)), NO_OPFS);
		await engineReady(page);
		await page.getByLabel('Video URL').fill('https://www.fixtures.test/split');
		await page.getByRole('button', { name: 'Fetch formats' }).click();

		// The page offers yt-dlp's bv*+ba: the video-only and audio-only streams, merged.
		const best = page.getByRole('region', { name: /^Best quality/ });
		await expect(best).toContainText('VP8 video + Opus audio, merged into one WEBM file', {
			timeout: EXTRACTION_MS
		});
		await expect(best).toContainText(/never re-encoded \(\d+(\.\d+)? KiB\)\./);
		// Until a merge starts, only a HEAD probe has asked about the FFmpeg core.
		expect(ffmpegRequests).toEqual(['HEAD /ffmpeg/ffmpeg-core.wasm']);

		const remuxWorker = page.waitForEvent('worker', (worker) =>
			worker.url().includes('remux.worker')
		);
		await best.getByRole('button', { name: 'Download best quality' }).click();

		// FFmpeg runs under the same header CSP as the engine: WebAssembly
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
		// Now the core has been fetched. (The worker's import() of ffmpeg-core.js is
		// not reported as a request in every browser; its wasm fetch is.)
		expect(ffmpegRequests).toContain('GET /ffmpeg/ffmpeg-core.wasm');

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
		await expect.poll(() => video.evaluate(hasAudio), { timeout: 15_000 }).toBe(true);

		expect(await violations()).toEqual([]);
		expect(consoleCsp).toEqual([]);
	});
});
