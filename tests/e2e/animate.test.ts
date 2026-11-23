import { readFileSync } from 'node:fs';
import type { Download, Locator, Page } from '@playwright/test';
import { decodeApng, decodePng } from '../helpers/apng';
import { loadFFmpegCore } from '../helpers/ffmpeg';
import { decodeGif } from '../helpers/gif';
import { readAvif } from '../helpers/isobmff';
import { decodeJxl } from '../helpers/jxl';
import { oracle } from '../helpers/oracle';
import { readAnimatedWebp, stillWebp } from '../helpers/webp';
import { expect, test } from './fixtures';
import {
	ENGINE_BOOT_MS,
	EXTRACTION_MS,
	NO_OPFS,
	engineReady,
	hasOpfs,
	opfsFiles,
	probe
} from './app';
import { ownViolations, recordConsoleCsp, recordCspViolations } from './csp';
import { FIXTURE_PATH, pickFiles, withoutSavePicker } from './device';

const FIXTURE = new Uint8Array(
	readFileSync(new URL('../fixtures/media/bbf-360.webm', import.meta.url))
);
/** The fixture clip: 640×360, 24 numbered frames at 12 fps. */
const FIXTURE_FPS = 12;

let ffmpeg: ReturnType<typeof oracle> | undefined;
/** ffmpeg.wasm, decoding independently of the browser. */
async function reference() {
	return (ffmpeg ??= oracle(await loadFFmpegCore()));
}

/**
 * The fixture's frames as FFmpeg decodes them, cropped to the top left — to the
 * pixel (`exact`): otherwise FFmpeg rounds an odd crop of 4:2:0 video down to
 * even, and a drag can end on an odd size.
 */
async function fixtureFrames(width: number, height: number): Promise<Uint8ClampedArray[]> {
	const ff = await reference();
	return ff.withFile('clip.webm', FIXTURE, (path) =>
		ff.rawFrames(['-i', path, '-vf', `crop=${width}:${height}:0:0:exact=1`], width, height)
	);
}

/** The fixture's frames as FFmpeg decodes them, the whole picture scaled to `width` × `height`. */
async function scaledFixtureFrames(width: number, height: number): Promise<Uint8ClampedArray[]> {
	const ff = await reference();
	return ff.withFile('clip.webm', FIXTURE, (path) =>
		ff.rawFrames(['-i', path, '-vf', `scale=${width}:${height}`], width, height)
	);
}

/**
 * Ten minutes of one still picture, a frame a second, made by ffmpeg.wasm: no fixture is
 * that long. Over it, the default 5 s range and the shortest zoom are narrower than a thumb.
 */
async function tenMinutes(): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
	const ff = await reference();
	const source = 'color=c=0x3366aa:size=160x90:rate=1:duration=600';
	ff.run([
		'-f',
		'lavfi',
		'-i',
		source,
		'-c:v',
		'libvpx',
		'-b:v',
		'20k',
		'-f',
		'webm',
		'/long.webm'
	]);
	return {
		name: 'ten-minutes.webm',
		mimeType: 'video/webm',
		buffer: Buffer.from(ff.take('/long.webm'))
	};
}

/** When picture k of the fixture starts: k/12 s, which WebM rounds to the millisecond. */
const pictureStart = (k: number) => Math.round((k * 1000) / FIXTURE_FPS) / 1000;

/** The pictures that may be on screen at `time`: the one there, or either, 2 ms from where one starts. */
function picturesAt(time: number): number[] {
	const at = (t: number) => {
		let k = 0;
		while (k + 1 < 2 * FIXTURE_FPS && pictureStart(k + 1) <= t) k++;
		return k;
	};
	return [...new Set([at(time - 0.002), at(time + 0.002)])];
}

/**
 * Root-mean-square difference per RGB channel, over RGBA pixels: a few pixels far apart
 * count for more than many a little apart — the number on a frame, more than its colors.
 */
function rmsDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let sum = 0;
	for (let i = 0; i < a.length; i += 4) {
		sum += (a[i] - b[i]) ** 2 + (a[i + 1] - b[i + 1]) ** 2 + (a[i + 2] - b[i + 2]) ** 2;
	}
	return Math.sqrt(sum / ((a.length / 4) * 3));
}

/** Mean absolute difference per RGB channel, over RGBA pixels. */
function difference(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let sum = 0;
	for (let i = 0; i < a.length; i += 4) {
		sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
	}
	return sum / ((a.length / 4) * 3);
}

/**
 * Checks that frame i of an animation made at 10 fps from 0.5 s on is the
 * clip's frame at 0.5 + i/10 s: the closest of all the clip's frames (their
 * numbers are drawn on them, so each is unlike the others), and close to it.
 */
function expectFramesOfRange(
	frames: ArrayLike<number>[],
	source: Uint8ClampedArray[],
	tolerance: number
): void {
	for (const [i, frame] of frames.entries()) {
		const time = 0.5 + i / 10;
		const differences = source.map((s) => difference(frame, s));
		const closest = differences.indexOf(Math.min(...differences));
		expect(closest, `frame at ${time.toFixed(1)} s`).toBe(Math.floor(time * FIXTURE_FPS + 1e-6));
		expect(differences[closest], `frame at ${time.toFixed(1)} s`).toBeLessThan(tolerance);
	}
}

/** Downloads the fixture clip and opens the animation maker on it. */
async function openEditor(page: Page): Promise<Locator> {
	// Exercise the plain-download path (showSaveFilePicker opens a native dialog).
	await page.addInitScript(() => {
		delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
	});
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
	await page.getByRole('button', { name: 'Make an animated image from Big Buck Fixture' }).click();
	const dialog = page.getByRole('dialog', { name: 'Make an animated image' });
	// The editor knows the clip's length once the browser has read it.
	await expect(dialog.getByRole('slider', { name: 'End' })).toHaveAttribute('aria-valuemax', '2', {
		timeout: 15_000
	});
	return dialog;
}

/**
 * Waits until the editor knows the clip's own rate, 12 fps: from then on, the
 * arrow keys step the time range a picture (1/12 s) at a time.
 */
async function rateKnown(dialog: Locator) {
	await expect(dialog.getByText('Video 12 fps')).toBeVisible({ timeout: 15_000 });
}

/**
 * 0.5 s to 1.5 s from the keyboard, six pictures in from either end; the top
 * left quarter by dragging the bottom right corner to the middle, 10 fps, full
 * size. Returns the crop.
 */
async function chooseRangeAndCrop(page: Page, dialog: Locator) {
	const start = dialog.getByRole('slider', { name: 'Start' });
	const end = dialog.getByRole('slider', { name: 'End' });
	await rateKnown(dialog);
	for (let i = 0; i < 6; i++) await start.press('ArrowRight');
	await end.press('End');
	for (let i = 0; i < 6; i++) await end.press('ArrowLeft');
	await expect(start).toHaveAttribute('aria-valuenow', '0.5');
	await expect(end).toHaveAttribute('aria-valuenow', '1.5');
	await expect(dialog.getByText('Length 1.0 s')).toBeVisible();

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
	const [width, height] = readout.match(/\d+/g)!.map(Number);
	// The top left quarter, give or take a screen pixel's worth.
	expect(Math.abs(width - 320)).toBeLessThanOrEqual(3);
	expect(Math.abs(height - 180)).toBeLessThanOrEqual(3);

	await dialog.getByLabel('Frame rate').selectOption({ label: '10 fps' });
	await dialog.getByLabel('Width').selectOption({ label: '640 px' });
	return { width, height };
}

/** Creates the animation in the chosen format and saves it; returns the saved bytes. */
async function createAndSave(page: Page, dialog: Locator, label: string): Promise<Uint8Array> {
	await dialog.getByRole('button', { name: `Create ${label}` }).click();
	const result = dialog.getByRole('region', { name: `Your ${label}` });
	// The file, or the dialog saying why there is none: a failure fails as itself,
	// and one that never ends says how far it got.
	const failure = dialog.getByRole('alert');
	try {
		await expect(result.or(failure)).toBeVisible({ timeout: 90_000 });
	} catch (error) {
		const status = await dialog.getByRole('status').allTextContents();
		throw new Error(`No ${label} after 90 s; the dialog says: ${status.join(' ') || 'nothing'}`, {
			cause: error
		});
	}
	expect(await failure.allTextContents(), `making the ${label}`).toEqual([]);
	await expect(result).toContainText('10 frames · 1.0 s');
	const [download]: [Download, void] = await Promise.all([
		page.waitForEvent('download'),
		result.getByRole('button', { name: `Save ${label}` }).click()
	]);
	expect(download.suggestedFilename()).toMatch(/^Big Buck Fixture.* \(0\.5s-1\.5s\) \[0\]\.\w+$/);
	return new Uint8Array(
		readFileSync((await probe(`wait for the saved ${label} to download`, () => download.path()))!)
	);
}

/** A frame sampled on a 16 × 9 grid: enough to tell the clip's frames apart. (browserDecode samples the same.) */
function grid(pixels: ArrayLike<number>, width: number, height: number): number[] {
	const out: number[] = [];
	for (let gy = 0; gy < 9; gy++) {
		for (let gx = 0; gx < 16; gx++) {
			const x = Math.floor(((gx + 0.5) * width) / 16);
			const y = Math.floor(((gy + 0.5) * height) / 9);
			const at = (y * width + x) * 4;
			out.push(pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]);
		}
	}
	return out;
}

interface BrowserDecoded {
	frameCount: number;
	repetitionCount: number;
	/** Microseconds. */
	durations: number[];
	frames: { width: number; height: number; grid: number[] }[];
}

/**
 * How the browser itself decodes `bytes` (WebCodecs' ImageDecoder), each
 * frame as its grid of samples (taken in the page, as `grid` takes them):
 * null where there is no ImageDecoder, or it cannot decode the type.
 */
async function browserDecode(
	page: Page,
	bytes: Uint8Array,
	type: string
): Promise<BrowserDecoded | null> {
	return probe(`decode the ${type} in the browser`, () =>
		page.evaluate(
			async ({ data, type }) => {
				if (typeof ImageDecoder !== 'function' || !(await ImageDecoder.isTypeSupported(type))) {
					return null;
				}
				const decoder = new ImageDecoder({ data: Uint8Array.from(data), type });
				await decoder.tracks.ready;
				await decoder.completed;
				const track = decoder.tracks.selectedTrack!;
				const frames = [];
				const durations = [];
				for (let i = 0; i < track.frameCount; i++) {
					const { image } = await decoder.decode({ frameIndex: i });
					const [width, height] = [image.displayWidth, image.displayHeight];
					const canvas = new OffscreenCanvas(width, height);
					const context = canvas.getContext('2d')!;
					context.drawImage(image, 0, 0);
					const pixels = context.getImageData(0, 0, width, height).data;
					const grid: number[] = [];
					for (let gy = 0; gy < 9; gy++) {
						for (let gx = 0; gx < 16; gx++) {
							const x = Math.floor(((gx + 0.5) * width) / 16);
							const y = Math.floor(((gy + 0.5) * height) / 9);
							const at = (y * width + x) * 4;
							grid.push(pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]);
						}
					}
					frames.push({ width, height, grid });
					durations.push(image.duration ?? 0);
					image.close();
				}
				decoder.close();
				return {
					frameCount: track.frameCount,
					repetitionCount: track.repetitionCount,
					durations,
					frames
				};
			},
			{ data: [...bytes], type }
		)
	);
}

test.describe('animated images from a video in the library', () => {
	test.describe.configure({ timeout: ENGINE_BOOT_MS + EXTRACTION_MS + 240_000 });

	test('a GIF is made of the chosen time range and crop, under the strict CSP', async ({
		page,
		request
	}) => {
		const violations = await recordCspViolations(page);
		const consoleCsp = recordConsoleCsp(page);
		const dialog = await openEditor(page);
		const crop = await chooseRangeAndCrop(page, dialog);
		// Never scaled up: the GIF is the crop's size.
		await expect(
			dialog.getByText(`GIF: ${crop.width} × ${crop.height} px · 10 frames`)
		).toBeVisible();

		const animateWorker = page.waitForEvent('worker', (worker) =>
			worker.url().includes('animate.worker')
		);
		const saved = createAndSave(page, dialog, 'GIF');
		// The encoders run under the workers' header CSP: no eval, no Trusted Types policies.
		const workerCsp = (await request.get((await animateWorker).url())).headers()[
			'content-security-policy'
		];
		expect(workerCsp).toContain("script-src 'self' 'wasm-unsafe-eval'");
		expect(workerCsp).toContain("require-trusted-types-for 'script'; trusted-types 'none'");
		const gif = decodeGif(await saved);
		// The browser shows it, at the crop's size.
		const image = dialog.getByRole('region', { name: 'Your GIF' }).getByRole('img');
		await expect
			.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
			.toBe(crop.width);

		expect(gif).toMatchObject({ width: crop.width, height: crop.height, loop: 0 });
		expect(gif.frames.reduce((sum, frame) => sum + frame.delay, 0)).toBe(100);
		expect(gif.frames).toHaveLength(10);
		// Each frame is the clip's frame at its time — 0.5 s, 0.6 s … 1.4 s — so none
		// comes from outside the range. (Chromium lands at 2-5; browsers convert YUV
		// to RGB a little differently from FFmpeg, and a crop in the wrong place
		// scores 40 and more.)
		expectFramesOfRange(
			gif.frames.map((f) => f.canvas),
			await fixtureFrames(crop.width, crop.height),
			20
		);

		expect(await violations()).toEqual([]);
		expect(consoleCsp).toEqual([]);
	});

	test('APNG, WebP, AVIF and JPEG XL are made of the same frames, each as its format says', async ({
		page
	}) => {
		const violations = await recordCspViolations(page);
		const consoleCsp = recordConsoleCsp(page);
		const dialog = await openEditor(page);
		const crop = await chooseRangeAndCrop(page, dialog);
		const source = await fixtureFrames(crop.width, crop.height);
		const format = dialog.getByLabel('Format');
		// The page asks a worker which formats this browser can make.
		await expect(format).toHaveAttribute('data-formats', 'known');
		const offered = async (label: string) =>
			format.getByRole('option', { name: new RegExp(`^${label}`) }).isEnabled();
		const choose = async (label: string) => {
			await format.selectOption({ label });
			await expect(
				dialog.getByText(`${label}: ${crop.width} × ${crop.height} px · 10 frames`)
			).toBeVisible();
		};
		/** Checks the browser's own decoding of a file against the frames the editor took. */
		const checkInBrowser = async (
			bytes: Uint8Array,
			mime: string,
			taken: Uint8ClampedArray[],
			tolerance: number
		) => {
			const decoded = await browserDecode(page, bytes, mime);
			if (!decoded) return false;
			expect(decoded.frameCount).toBe(10);
			expect(decoded.repetitionCount).toBe(Infinity);
			expect(decoded.durations.reduce((a, b) => a + b, 0)).toBeCloseTo(1_000_000, -3);
			const references = taken.map((frame) => grid(frame, crop.width, crop.height));
			for (const [i, frame] of decoded.frames.entries()) {
				expect([frame.width, frame.height]).toEqual([crop.width, crop.height]);
				const differences = references.map((r) => difference(frame.grid, r));
				// How far it is from each frame taken: what a failure needs to be explained.
				const from = `frame ${i}, from each taken: ${differences.map((d) => d.toFixed(1)).join(' ')}`;
				expect(differences.indexOf(Math.min(...differences)), from).toBe(i);
				expect(differences[i], from).toBeLessThan(tolerance);
			}
			return true;
		};

		// APNG is lossless: its frames are exactly what the editor took, and the
		// reference the lossy formats are held to.
		let taken: Uint8ClampedArray[] = [];
		await test.step('APNG', async () => {
			expect(await offered('APNG')).toBe(true);
			await choose('APNG');
			const bytes = await createAndSave(page, dialog, 'APNG');
			const apng = decodeApng(bytes);
			expect(apng).toMatchObject({ width: crop.width, height: crop.height, plays: 0 });
			expect(apng.frames.reduce((sum, f) => sum + f.delay.num / f.delay.den, 0)).toBeCloseTo(1, 6);
			taken = apng.frames.map((f) => f.canvas);
			expect(taken).toHaveLength(10);
			expectFramesOfRange(taken, source, 20);
			await checkInBrowser(bytes, 'image/apng', taken, 1);
		});

		await test.step('WebP', async () => {
			if (!(await offered('WebP'))) {
				test.info().annotations.push({ type: 'skip', description: 'cannot encode WebP here' });
				return;
			}
			await choose('WebP');
			await expect(dialog.getByLabel('Quality')).toHaveValue('75');
			const bytes = await createAndSave(page, dialog, 'WebP');
			const webp = readAnimatedWebp(bytes);
			expect(webp).toMatchObject({ width: crop.width, height: crop.height, loops: 0 });
			expect(webp.frames.map((f) => f.duration)).toEqual(Array(10).fill(100));
			// FFmpeg decodes each frame: lossy, but still the frame of its time.
			const ff = await reference();
			const frames = webp.frames.map(
				(f) => ff.decode(stillWebp(f), 'webp', crop.width, crop.height)[0]
			);
			expectFramesOfRange(frames, source, 25);
			await checkInBrowser(bytes, 'image/webp', taken, 25);
		});

		await test.step('AVIF', async () => {
			if (!(await offered('AVIF'))) {
				test.info().annotations.push({ type: 'skip', description: 'cannot encode AV1 here' });
				return;
			}
			await choose('AVIF');
			const bytes = await createAndSave(page, dialog, 'AVIF');
			const avif = readAvif(bytes);
			expect(avif.brands.major).toBe('avis');
			expect(avif.track).toMatchObject({
				width: crop.width,
				height: crop.height,
				timescale: 10,
				repeat: true
			});
			expect(avif.track.durations).toEqual(Array(10).fill(1));
			// Nothing in Node decodes AV1: the browser does, and its frames match the APNG's.
			expect(await checkInBrowser(bytes, 'image/avif', taken, 25)).toBe(true);
		});

		await test.step('JPEG XL', async () => {
			expect(await offered('JPEG XL')).toBe(true);
			await choose('JPEG XL');
			const bytes = await createAndSave(page, dialog, 'JPEG XL');
			// jxl-oxide decodes it: lossless, the very frames the editor took.
			const jxl = decodeJxl(bytes);
			expect(jxl).toMatchObject({
				width: crop.width,
				height: crop.height,
				animated: true,
				loops: 0
			});
			expect(jxl.frames.map((f, i) => difference(f.pixels, taken[i]))).toEqual(Array(10).fill(0));
			const result = dialog.getByRole('region', { name: 'Your JPEG XL' });
			if (await checkInBrowser(bytes, 'image/jxl', taken, 1)) {
				const image = result.getByRole('img');
				await expect
					.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
					.toBe(crop.width);
			} else {
				// Most browsers cannot show JPEG XL yet: the page says so instead of a broken image.
				await expect(result.locator('[data-unshowable]')).toBeVisible();
			}
		});

		expect(await violations()).toEqual([]);
		expect(consoleCsp).toEqual([]);
	});
});

/** Waits until every picture of the strip is drawn, at the times it should show. */
async function stripDrawn(strip: Locator, times?: (count: number) => number[]) {
	const tiles = strip.locator('canvas');
	await expect
		.poll(
			async () => {
				const count = await tiles.count();
				if (!(count > 0 && (await strip.getAttribute('data-taken')) === String(count)))
					return false;
				if (!times) return true;
				const shown = await tiles.evaluateAll((all) => all.map((c) => Number(c.dataset.time)));
				return JSON.stringify(shown) === JSON.stringify(times(count));
			},
			{ timeout: 15_000, message: 'every picture of the strip drawn' }
		)
		.toBe(true);
}

/** When each of `count` pictures across `from`–`to` is taken: the middle of its stretch. */
const tileTimes = (from: number, to: number, count: number) =>
	Array.from(
		{ length: count },
		(_, i) => Math.round((from + ((i + 0.5) * (to - from)) / count) * 1e6) / 1e6
	);

/**
 * Each tile is the picture on screen at its time, the middle of the stretch it stands for:
 * the closest of all the clip's pictures (as ffmpeg.wasm decodes them, at the tile's size),
 * and close to it. (Chromium lands at 4-5, WebKit 5-7 and Firefox, whose colors are
 * further from FFmpeg's, 8-11; the next closest at least 2 more, a blank tile 120.)
 * Returns the tiles' times.
 */
async function expectTilesOfTheirTimes(strip: Locator): Promise<number[]> {
	const pictures = await probe('read the frame timeline', () =>
		strip.evaluate((element) =>
			[...element.querySelectorAll('canvas')].map((canvas) => ({
				time: Number(canvas.dataset.time),
				width: canvas.width,
				height: canvas.height,
				pixels: [...canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data]
			}))
		)
	);
	const { width, height } = pictures[0];
	const box = (await strip.boundingBox())!;
	expect(pictures.length).toBe(Math.ceil(box.width / (box.height * (640 / 360))));
	const source = await scaledFixtureFrames(width, height);
	for (const { time, pixels } of pictures) {
		const differences = source.map((frame) => rmsDifference(pixels, frame));
		const closest = differences.indexOf(Math.min(...differences));
		const from = `tile at ${time} s, from each picture: ${differences.map((d) => d.toFixed(1)).join(' ')}`;
		expect(picturesAt(time), from).toContain(closest);
		expect(differences[closest], from).toBeLessThan(15);
	}
	return pictures.map((p) => p.time);
}

const center = async (locator: Locator) => {
	const { x, width } = (await locator.boundingBox())!;
	return x + width / 2;
};

/**
 * Where on its track the time range, or the stretch the zoom shows, starts and
 * ends: each end's thumb stands inside, the start's from where it starts, the
 * end's up to where it ends.
 */
const startsAt = async (start: Locator) => (await start.boundingBox())!.x;
const endsAt = async (end: Locator) => {
	const { x, width } = (await end.boundingBox())!;
	return x + width;
};

type Box = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;

/**
 * Two thumbs on a track (its box), side by side: the first wholly before the second, both
 * on the track, and each the one a press at its middle lands on.
 */
async function expectApartAndInReach(track: Box, first: Locator, second: Locator) {
	const [a, b] = [(await first.boundingBox())!, (await second.boundingBox())!];
	expect(a.x).toBeGreaterThanOrEqual(track.x - 0.5);
	expect(a.x + a.width).toBeLessThanOrEqual(b.x + 0.5);
	expect(b.x + b.width).toBeLessThanOrEqual(track.x + track.width + 0.5);
	// Only the checks a click makes, the one a covered element fails: nothing in the way.
	for (const thumb of [first, second]) await thumb.click({ trial: true, timeout: 5_000 });
}

/** Drags `handle` across to `x`, from its middle. */
async function dragTo(page: Page, handle: Locator, x: number) {
	const box = (await handle.boundingBox())!;
	const y = box.y + box.height / 2;
	await page.mouse.move(box.x + box.width / 2, y);
	await page.mouse.down();
	await page.mouse.move(x, y, { steps: 8 });
	await page.mouse.up();
}

/** Drags `handle` `dx` pixels along, from its middle. */
async function dragBy(page: Page, handle: Locator, dx: number) {
	await dragTo(page, handle, (await center(handle)) + dx);
}

/** Drags a start's thumb, from its middle, until where it starts is at `x`. */
async function dragStartTo(page: Page, start: Locator, x: number) {
	await dragBy(page, start, x - (await startsAt(start)));
}

/** Drags an end's thumb, from its middle, until where it ends is at `x`. */
async function dragEndTo(page: Page, end: Locator, x: number) {
	await dragBy(page, end, x - (await endsAt(end)));
}

test.describe('the animations made in this tab', () => {
	test.describe.configure({ timeout: 240_000 });

	test('are kept to view again, step through, save and remove, until the page is reloaded', async ({
		page
	}) => {
		const violations = await recordCspViolations(page);
		const consoleCsp = recordConsoleCsp(page);
		await withoutSavePicker(page);
		// Straight from disk: no engine, no private storage, in every browser.
		await page.goto('/library/');
		const shelf = page.getByRole('region', { name: 'Animations' });
		await expect(page.getByRole('button', { name: 'Animate a video file…' })).toBeVisible();
		await expect(shelf).toHaveCount(0);
		await pickFiles(page, 'Animate a video file…', [FIXTURE_PATH]);
		const dialog = page.getByRole('dialog', { name: 'Make an animated image' });
		await expect(dialog.getByRole('slider', { name: 'End' })).toHaveAttribute(
			'aria-valuemax',
			'2',
			{ timeout: 15_000 }
		);

		/** Makes the animation the editor is set to, and checks what the dialog says of it. */
		const make = async (label: string, made: string) => {
			await dialog.getByRole('button', { name: `Create ${label}` }).click();
			const result = dialog.getByRole('region', { name: `Your ${label}` });
			const failure = dialog.getByRole('alert');
			await expect(result.or(failure)).toBeVisible({ timeout: 90_000 });
			expect(await failure.allTextContents(), `making the ${label}`).toEqual([]);
			await expect(result).toContainText(made);
			// Where it is kept, and for how long.
			await expect(result).toContainText(
				'Also kept under Animations on the library page until this tab is reloaded or closed'
			);
		};
		// The whole clip (24 pictures at its own 12 fps): a GIF, then an APNG half as wide.
		await make('GIF', '480 × 270 px · 24 frames · 2.0 s');
		await dialog.getByLabel('Format').selectOption({ label: 'APNG' });
		await dialog.getByLabel('Width').selectOption({ label: '240 px' });
		await make('APNG', '240 × 135 px · 24 frames · 2.0 s');
		await dialog.getByRole('button', { name: 'Close the animation maker' }).click();

		// Both are on the library page, newest first, each the animation itself, playing.
		const gif = 'GIF of bbf-360, 0:00.0 to 0:02.0';
		const apng = 'APNG of bbf-360, 0:00.0 to 0:02.0';
		const cards = shelf
			.getByRole('list', { name: 'Animations made in this tab' })
			.getByRole('listitem');
		await expect(cards).toHaveCount(2);
		await expect(shelf).toContainText('2 animations ·');
		await expect(cards.nth(0).getByRole('figure')).toHaveAttribute('aria-label', apng);
		await expect(cards.nth(1).getByRole('figure')).toHaveAttribute('aria-label', gif);
		await expect(cards.nth(0)).toContainText('240 × 135 px');
		await expect(cards.nth(1)).toContainText('480 × 270 px');
		const shownWidth = (image: Locator) =>
			expect.poll(() =>
				image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)
			);
		await shownWidth(cards.nth(0).locator('img')).toBe(240);
		await shownWidth(cards.nth(1).locator('img')).toBe(480);

		// Viewed large, at its own size, and the others a step away (round from the last).
		await page.getByRole('button', { name: `View ${gif}` }).click();
		const viewer = page.getByRole('dialog', { name: 'bbf-360' });
		const image = viewer.getByRole('img');
		await expect(viewer).toContainText('GIF of 0:00.0 to 0:02.0 of the video');
		await expect(viewer).toContainText('2 of 2');
		await shownWidth(image).toBe(480);
		expect((await image.boundingBox())!.width).toBeCloseTo(480, 0);
		await viewer.getByRole('button', { name: 'Next animation' }).click();
		await expect(viewer).toContainText('APNG of 0:00.0 to 0:02.0 of the video');
		await expect(viewer).toContainText('1 of 2');
		await shownWidth(image).toBe(240);
		await page.keyboard.press('ArrowLeft');
		await expect(viewer).toContainText('2 of 2');
		await page.keyboard.press('ArrowRight');
		await expect(viewer).toContainText('1 of 2');

		// Saved from the viewer, it is the APNG that was made (WebKit saves spaces as "_").
		const [savedApng]: [Download, void] = await Promise.all([
			page.waitForEvent('download'),
			viewer.getByRole('button', { name: 'Save APNG' }).click()
		]);
		expect(savedApng.suggestedFilename()).toMatch(/^bbf-360[ _]\(0\.0s-2\.0s\)\.png$/);
		const decoded = decodeApng(
			new Uint8Array(
				readFileSync((await probe('wait for the saved APNG', () => savedApng.path()))!)
			)
		);
		expect(decoded).toMatchObject({ width: 240, height: 135, plays: 0 });
		expect(decoded.frames).toHaveLength(24);

		// Removed, it is gone, and the viewer shows the one left.
		await viewer.getByRole('button', { name: 'Remove' }).click();
		await expect(viewer).toContainText('GIF of 0:00.0 to 0:02.0 of the video');
		await expect(viewer.getByRole('button', { name: 'Next animation' })).toHaveCount(0);
		await viewer.getByRole('button', { name: 'Close the animation viewer' }).click();
		await expect(viewer).toHaveCount(0);
		await expect(cards).toHaveCount(1);
		await expect(shelf).toContainText('1 animation ·');

		// It saves from its card too.
		const [savedGif]: [Download, void] = await Promise.all([
			page.waitForEvent('download'),
			page.getByRole('button', { name: `Save ${gif}` }).click()
		]);
		expect(savedGif.suggestedFilename()).toMatch(/^bbf-360[ _]\(0\.0s-2\.0s\)\.gif$/);
		const savedFrames = decodeGif(
			new Uint8Array(readFileSync((await probe('wait for the saved GIF', () => savedGif.path()))!))
		);
		expect(savedFrames).toMatchObject({ width: 480, height: 270 });
		expect(savedFrames.frames).toHaveLength(24);

		// Kept while moving about the app, stored nowhere, and gone with a reload.
		const nav = page.getByRole('navigation', { name: 'Main' });
		await nav.getByRole('link', { name: 'Download', exact: true }).click();
		await expect(page.getByLabel('Video URL')).toBeVisible();
		await nav.getByRole('link', { name: 'Library', exact: true }).click();
		await expect(cards).toHaveCount(1);
		if (await hasOpfs(page)) expect(await opfsFiles(page)).toEqual([]);
		await page.reload();
		await expect(page.getByRole('button', { name: 'Animate a video file…' })).toBeVisible();
		await expect(shelf).toHaveCount(0);

		expect(await violations()).toEqual([]);
		expect(consoleCsp).toEqual([]);
	});
});

test.describe('the frame timeline', () => {
	// Pictures drawn at twice the size: the low-bitrate encode left some of the clip's frames
	// alike but for their numbers, which need the pixels.
	test.use({ deviceScaleFactor: 2 });

	test("shows the video's pictures across the time range, and marks each frame the animation takes", async ({
		page
	}) => {
		const violations = await recordCspViolations(page);
		// Straight from disk: no engine, no private storage, in every browser.
		await page.goto('/library/');
		await pickFiles(page, 'Animate a video file…', [FIXTURE_PATH]);
		const dialog = page.getByRole('dialog', { name: 'Make an animated image' });
		const track = dialog.getByRole('group', { name: 'Time range' });
		const strip = track.locator('.filmstrip');
		await stripDrawn(strip);
		const times = await expectTilesOfTheirTimes(strip);
		// Across the whole clip.
		expect(times).toEqual(tileTimes(0, 2, times.length));

		// A mark where each frame is taken: from the start of the range to its end, as many as the
		// animation has frames.
		const start = dialog.getByRole('slider', { name: 'Start' });
		const end = dialog.getByRole('slider', { name: 'End' });
		const marks = track.locator('.marks');
		const summary = dialog.locator('#animate-summary');
		const expectMarksOfRange = async (frames: number) => {
			await expect(summary).toContainText(`· ${frames} frames`);
			await expect(marks).toHaveAttribute('data-frames', String(frames));
			const { x, width } = (await marks.boundingBox())!;
			expect(Math.abs(x - (await startsAt(start)))).toBeLessThanOrEqual(1);
			expect(Math.abs(x + width - (await endsAt(end)))).toBeLessThanOrEqual(1);
		};
		await expect(dialog.getByLabel('Frame rate')).toHaveValue('12');
		// The clip's own rate, learned in a video of its own while the editor was already open.
		await expect(dialog.getByText('Video 12 fps')).toBeVisible();
		await expect(dialog.locator('[data-measuring]')).toHaveCount(0);
		await expectMarksOfRange(24);
		// Six pictures in: half a second.
		for (let i = 0; i < 6; i++) await start.press('ArrowRight');
		await expectMarksOfRange(18);
		// The first frame's mark shows over the Start thumb, which stands on it: a light line on
		// the thumb's accent, where the marks run along the track's foot.
		const thumb = (await start.boundingBox())!;
		const ticks = (await marks.boundingBox())!;
		const clip = { x: thumb.x, y: ticks.y + 1, width: 3, height: ticks.height - 2 };
		const { pixels } = decodePng(await page.screenshot({ clip }));
		const light = pixels.filter((_, i) => i % 4 === 1 && pixels[i] >= 128).length;
		expect(light, "light pixels of the first frame's mark over the Start thumb").toBeGreaterThan(0);
		await dialog.getByLabel('Frame rate').selectOption({ label: '10 fps' });
		await expectMarksOfRange(15);

		// The pictures and the darkening are behind the controls: pressing the track over them,
		// outside the range, still brings the nearer end there.
		const { x, y, width: trackWidth, height: trackHeight } = (await track.boundingBox())!;
		await page.mouse.click(x + trackWidth * 0.1, y + trackHeight / 2);
		// To a screen pixel's worth of 0.2 s (pointer events may say where in whole pixels).
		await expect
			.poll(async () => Math.abs(Number(await start.getAttribute('aria-valuenow')) - 0.2))
			.toBeLessThanOrEqual(2 / trackWidth + 0.001);

		// Taking a screenshot, Playwright's WebKit trips the page's CSP itself (`SCREENSHOT_STYLE`).
		expect(ownViolations(await violations())).toEqual([]);
	});

	test('zooms in on a stretch by the handles under it, to set the range picture by picture', async ({
		page
	}) => {
		const violations = await recordCspViolations(page);
		await page.goto('/library/');
		await pickFiles(page, 'Animate a video file…', [FIXTURE_PATH]);
		const dialog = page.getByRole('dialog', { name: 'Make an animated image' });
		const track = dialog.getByRole('group', { name: 'Time range' });
		const strip = track.locator('.filmstrip');
		const zoom = dialog.getByRole('group', { name: 'Timeline zoom' });
		const zoomFrom = dialog.getByRole('slider', { name: 'Zoom from' });
		const zoomTo = dialog.getByRole('slider', { name: 'Zoom to' });
		const start = dialog.getByRole('slider', { name: 'Start' });
		const end = dialog.getByRole('slider', { name: 'End' });
		const value = async (slider: Locator) => Number(await slider.getAttribute('aria-valuenow'));
		await expect(end).toHaveAttribute('aria-valuemax', '2', { timeout: 15_000 });
		// Zoomed out, the zoom shows all of the clip.
		await expect(zoomFrom).toHaveAttribute('aria-valuenow', '0');
		await expect(zoomTo).toHaveAttribute('aria-valuenow', '2');
		await stripDrawn(strip);
		// 0.5 s to 1.5 s, six pictures in from either end.
		await rateKnown(dialog);
		for (let i = 0; i < 6; i++) await start.press('ArrowRight');
		for (let i = 0; i < 6; i++) await end.press('ArrowLeft');

		// Its ends dragged an eighth and five eighths of the way along: 0.25 s to 1.25 s, to a pixel.
		// The range's start is well inside that, its end (1.5 s) beyond it.
		const bar = (await zoom.boundingBox())!;
		const barPixel = 2 / bar.width;
		await dragEndTo(page, zoomTo, bar.x + bar.width * 0.625);
		await dragStartTo(page, zoomFrom, bar.x + bar.width * 0.125);
		const [from, to] = [await value(zoomFrom), await value(zoomTo)];
		expect(Math.abs(from - 0.25)).toBeLessThanOrEqual(2 * barPixel + 0.001);
		expect(Math.abs(to - 1.25)).toBeLessThanOrEqual(2 * barPixel + 0.001);

		// The timeline's pictures are now of that stretch alone, taken afresh.
		await stripDrawn(strip, (count) => tileTimes(from, to, count));
		await expectTilesOfTheirTimes(strip);

		// The range's start stands where its time is in the stretch; its end, outside, is hidden.
		const box = (await track.boundingBox())!;
		const at = (time: number) => box.x + ((time - from) / (to - from)) * box.width;
		expect(Math.abs((await startsAt(start)) - at(0.5))).toBeLessThanOrEqual(1.5);
		await expect(end).toHaveClass(/outside/);

		// A tenth of the track is now a tenth of a second, not a fifth: finer by the zoom.
		await dragBy(page, start, box.width / 10);
		const pixel = (to - from) / box.width;
		expect(Math.abs((await value(start)) - (0.5 + (to - from) / 10))).toBeLessThanOrEqual(
			2 * pixel + 0.001
		);
		await expect(dialog.getByText(/^Length 0\.9 s$/)).toBeVisible();
		// Dragging never moves the stretch shown.
		await expect(zoomTo).toHaveAttribute('aria-valuenow', String(to));

		// Focus from the keyboard on the hidden end moves the timeline along to show it.
		await end.focus();
		await expect(zoomTo).toHaveAttribute('aria-valuenow', '1.5');
		await expect(end).not.toHaveClass(/outside/);
		await expect(end).toBeFocused();

		expect(await violations()).toEqual([]);
	});
});

test.describe('the time range', () => {
	test('moves whole by the tab under it, its length kept', async ({ page }) => {
		const violations = await recordCspViolations(page);
		// Straight from disk: no engine, no private storage, in every browser.
		await page.goto('/library/');
		await pickFiles(page, 'Animate a video file…', [FIXTURE_PATH]);
		const dialog = page.getByRole('dialog', { name: 'Make an animated image' });
		const track = dialog.getByRole('group', { name: 'Time range' });
		const start = dialog.getByRole('slider', { name: 'Start' });
		const end = dialog.getByRole('slider', { name: 'End' });
		const tab = dialog.getByRole('slider', { name: 'Move the range' });
		await expect(end).toHaveAttribute('aria-valuemax', '2', { timeout: 15_000 });
		// 0.5 s to 1.0 s of the 2 s clip: six pictures in, and twelve back from the end.
		await rateKnown(dialog);
		for (let i = 0; i < 6; i++) await start.press('ArrowRight');
		for (let i = 0; i < 12; i++) await end.press('ArrowLeft');
		await expect(tab).toHaveAttribute('aria-valuetext', '0:00.5 to 0:01.0');

		// It hangs under the middle of the range.
		const center = async (locator: Locator) => {
			const { x, width } = (await locator.boundingBox())!;
			return x + width / 2;
		};
		const middle = ((await center(start)) + (await center(end))) / 2;
		expect(Math.abs((await center(tab)) - middle)).toBeLessThanOrEqual(1);
		const box = (await tab.boundingBox())!;
		const trackBox = (await track.boundingBox())!;
		expect(box.y).toBeGreaterThanOrEqual(trackBox.y + trackBox.height - 1);

		// Dragged a quarter of the track to the right: half a second later, as long as before.
		const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x + trackBox.width / 4, y, { steps: 8 });
		await page.mouse.up();
		await expect(tab).toBeFocused();
		await expect(dialog.getByText('Length 0.5 s')).toBeVisible();
		// To two screen pixels' worth (pointer events may say where in whole pixels).
		const moved = Number(await start.getAttribute('aria-valuenow'));
		expect(Math.abs(moved - 1)).toBeLessThanOrEqual(4 / trackBox.width + 0.001);
		expect(Number(await end.getAttribute('aria-valuenow'))).toBeCloseTo(moved + 0.5, 3);

		// From the keyboard, to either end of the clip.
		await tab.press('End');
		await expect(tab).toHaveAttribute('aria-valuetext', '0:01.5 to 0:02.0');
		await tab.press('Home');
		await expect(tab).toHaveAttribute('aria-valuetext', '0:00.0 to 0:00.5');
		// An arrow moves it a picture.
		await tab.press('ArrowRight');
		await expect(start).toHaveAttribute('aria-valuenow', String(pictureStart(1)));
		await expect(end).toHaveAttribute('aria-valuenow', String(pictureStart(1) + 0.5));

		expect(await violations()).toEqual([]);
	});

	test("keeps its ends on the track, flush with it at the clip's ends and in line with the zoom's", async ({
		page
	}) => {
		const violations = await recordCspViolations(page);
		await page.goto('/library/');
		await pickFiles(page, 'Animate a video file…', [FIXTURE_PATH]);
		const dialog = page.getByRole('dialog', { name: 'Make an animated image' });
		const track = dialog.getByRole('group', { name: 'Time range' });
		const start = dialog.getByRole('slider', { name: 'Start' });
		const end = dialog.getByRole('slider', { name: 'End' });
		const zoom = dialog.getByRole('group', { name: 'Timeline zoom' });
		const zoomFrom = dialog.getByRole('slider', { name: 'Zoom from' });
		const zoomTo = dialog.getByRole('slider', { name: 'Zoom to' });
		const value = async (slider: Locator) => Number(await slider.getAttribute('aria-valuenow'));
		await expect(end).toHaveAttribute('aria-valuemax', '2', { timeout: 15_000 });
		const box = (await track.boundingBox())!;
		const [left, right] = [box.x, box.x + box.width];
		const expectOnTrack = async () => {
			expect(await startsAt(start)).toBeGreaterThanOrEqual(left - 0.5);
			expect(await endsAt(end)).toBeLessThanOrEqual(right + 0.5);
			// Each where its time is.
			const at = (time: number) => left + (time / 2) * box.width;
			expect(Math.abs((await startsAt(start)) - at(await value(start)))).toBeLessThanOrEqual(1);
			expect(Math.abs((await endsAt(end)) - at(await value(end)))).toBeLessThanOrEqual(1);
		};

		// The whole 2 s clip to begin with: from the track's start to its end, and no further.
		await expect(start).toHaveAttribute('aria-valuenow', '0');
		await expect(end).toHaveAttribute('aria-valuenow', '2');
		await expectOnTrack();
		// The zoom under it shows the whole clip: its ends' thumbs in line with the range's, edge
		// for edge — as wide as them.
		await expect(zoomFrom).toHaveAttribute('aria-valuenow', '0');
		await expect(zoomTo).toHaveAttribute('aria-valuenow', '2');
		expect(Math.abs((await startsAt(zoomFrom)) - left)).toBeLessThanOrEqual(0.5);
		expect(Math.abs((await endsAt(zoomTo)) - right)).toBeLessThanOrEqual(0.5);
		expect(Math.abs((await endsAt(zoomFrom)) - (await endsAt(start)))).toBeLessThanOrEqual(0.5);
		expect(Math.abs((await startsAt(zoomTo)) - (await startsAt(end)))).toBeLessThanOrEqual(0.5);
		// Nothing is drawn past either end of the track or the zoom — not their ends, not the
		// preview's mark at 0:00: just beside them, from above the range's thumbs to below the
		// zoom's, the dialog's own background alone.
		await expect(track.locator('.playhead')).toHaveCount(1);
		const zoomBox = (await zoom.boundingBox())!;
		for (const x of [Math.floor(left) - 4, Math.ceil(right)]) {
			const clip = {
				x,
				y: box.y - 6,
				width: 4,
				height: zoomBox.y + zoomBox.height + 6 - (box.y - 6)
			};
			const { width, pixels } = decodePng(await page.screenshot({ clip }));
			const color = (i: number) => pixels.subarray(i * 4, i * 4 + 4).join();
			const drawn = [];
			for (let i = 0; i < pixels.length / 4; i++) {
				if (color(i) !== color(0))
					drawn.push(`(${i % width}, ${Math.floor(i / width)}) ${color(i)}`);
			}
			expect(drawn, `beside the track and the zoom at x = ${x}, on ${color(0)}`).toEqual([]);
		}

		// Dragged from their middles, the ends move as far as the pointer does: a quarter of the
		// track, half a second, to two screen pixels' worth.
		await dragBy(page, start, box.width / 4);
		await dragBy(page, end, -box.width / 4);
		const pixel = 2 / box.width;
		expect(Math.abs((await value(start)) - 0.5)).toBeLessThanOrEqual(2 * pixel + 0.001);
		expect(Math.abs((await value(end)) - 1.5)).toBeLessThanOrEqual(2 * pixel + 0.001);
		await expectOnTrack();

		// Dragged out past the track's ends, they stop at the clip's, still on the track.
		await dragTo(page, start, left - 6);
		await dragTo(page, end, right + 6);
		await expect(start).toHaveAttribute('aria-valuenow', '0');
		await expect(end).toHaveAttribute('aria-valuenow', '2');
		await expectOnTrack();

		// Taking screenshots, Playwright's WebKit trips the page's CSP itself (`SCREENSHOT_STYLE`).
		expect(ownViolations(await violations())).toEqual([]);
	});

	test("steps a picture at a time with the arrow keys, once it knows the clip's rate", async ({
		page
	}) => {
		const violations = await recordCspViolations(page);
		await page.goto('/library/');
		await pickFiles(page, 'Animate a video file…', [FIXTURE_PATH]);
		const dialog = page.getByRole('dialog', { name: 'Make an animated image' });
		const start = dialog.getByRole('slider', { name: 'Start' });
		const end = dialog.getByRole('slider', { name: 'End' });
		await expect(end).toHaveAttribute('aria-valuemax', '2', { timeout: 15_000 });
		await rateKnown(dialog);
		// Which of the clip's pictures the stage shows: the closest of them all, as FFmpeg decodes
		// them, to the stage's video drawn at a quarter of its size.
		const [width, height] = [160, 90];
		const source = await scaledFixtureFrames(width, height);
		const stagePicture = async () => {
			const pixels = await probe('read the stage', () =>
				dialog.locator('.stage video').evaluate(
					(video: HTMLVideoElement, [w, h]) => {
						const canvas = document.createElement('canvas');
						canvas.width = w;
						canvas.height = h;
						const context = canvas.getContext('2d')!;
						context.drawImage(video, 0, 0, w, h);
						return [...context.getImageData(0, 0, w, h).data];
					},
					[width, height]
				)
			);
			const differences = source.map((frame) => rmsDifference(pixels, frame));
			return differences.indexOf(Math.min(...differences));
		};

		// Each press: where the next picture starts, and the stage shows it.
		for (let k = 1; k <= 7; k++) {
			await start.press('ArrowRight');
			await expect(start).toHaveAttribute('aria-valuenow', String(pictureStart(k)));
			await expect.poll(stagePicture, { message: `picture ${k} shown` }).toBe(k);
		}
		await start.press('ArrowLeft');
		await expect(start).toHaveAttribute('aria-valuenow', String(pictureStart(6)));
		await expect.poll(stagePicture, { message: 'picture 6 shown' }).toBe(6);
		// With Shift, still a second.
		await start.press('Shift+ArrowRight');
		await expect(start).toHaveAttribute('aria-valuenow', '1.5');
		// The end steps back from the clip's end a picture at a time.
		await end.press('ArrowLeft');
		await expect(end).toHaveAttribute('aria-valuenow', String(pictureStart(23)));

		expect(await violations()).toEqual([]);
	});
});

test.describe('the timeline of a long video', () => {
	test('keeps the ends of a short range and of a narrow zoom apart and in reach, and the zoom moves by its tab', async ({
		page
	}) => {
		const violations = await recordCspViolations(page);
		const clip = await tenMinutes();
		await page.goto('/library/');
		await pickFiles(page, 'Animate a video file…', [clip]);
		const dialog = page.getByRole('dialog', { name: 'Make an animated image' });
		const track = dialog.getByRole('group', { name: 'Time range' });
		const zoom = dialog.getByRole('group', { name: 'Timeline zoom' });
		const start = dialog.getByRole('slider', { name: 'Start' });
		const end = dialog.getByRole('slider', { name: 'End' });
		const tab = dialog.getByRole('slider', { name: 'Move the range' });
		const zoomFrom = dialog.getByRole('slider', { name: 'Zoom from' });
		const zoomTo = dialog.getByRole('slider', { name: 'Zoom to' });
		const zoomTab = dialog.getByRole('slider', { name: 'Move the zoom' });
		const value = async (slider: Locator) => Number(await slider.getAttribute('aria-valuenow'));
		await expect(end).toHaveAttribute('aria-valuemax', '600', { timeout: 15_000 });
		const box = (await track.boundingBox())!;
		const bar = (await zoom.boundingBox())!;
		const at = (time: number) => box.x + (time / 600) * box.width;

		// Its first five seconds, narrower than a thumb: the two stand side by side from the
		// track's start, each in reach.
		await expect(start).toHaveAttribute('aria-valuenow', '0');
		await expect(end).toHaveAttribute('aria-valuenow', '5');
		expect((5 / 600) * box.width).toBeLessThan((await start.boundingBox())!.width);
		await expectApartAndInReach(box, start, end);
		expect(Math.abs((await startsAt(start)) - box.x)).toBeLessThanOrEqual(0.5);

		// Moved to the video's end, up to the track's end.
		await tab.press('End');
		await expect(end).toHaveAttribute('aria-valuenow', '600');
		await expectApartAndInReach(box, start, end);
		expect(Math.abs((await endsAt(end)) - (box.x + box.width))).toBeLessThanOrEqual(0.5);

		// Half the track back, they meet where the range's middle is.
		await dragBy(page, tab, -box.width / 2);
		const [from, to] = [await value(start), await value(end)];
		expect(to - from).toBeCloseTo(5, 3);
		await expectApartAndInReach(box, start, end);
		expect(Math.abs((await endsAt(start)) - at((from + to) / 2))).toBeLessThanOrEqual(1);
		expect(Math.abs((await startsAt(end)) - at((from + to) / 2))).toBeLessThanOrEqual(1);

		// Each still takes a drag: the end a tenth of the track on, then the start a tenth back,
		// a minute each, to two screen pixels' worth.
		await dragBy(page, end, box.width / 10);
		await dragBy(page, start, -box.width / 10);
		const pixel = 600 / box.width;
		expect(Math.abs((await value(end)) - (to + 60))).toBeLessThanOrEqual(2 * pixel + 0.001);
		expect(Math.abs((await value(start)) - (from - 60))).toBeLessThanOrEqual(2 * pixel + 0.001);

		// The shortest zoom, half a second of ten minutes, under a pixel of the bar: its handles
		// stand side by side too, each in reach.
		await expect(zoomTab).toHaveCount(0);
		await zoomTo.press('Home');
		await expect(zoomTo).toHaveAttribute('aria-valuenow', '0.5');
		await expectApartAndInReach(bar, zoomFrom, zoomTo);

		// Its tab moves it along, as long as before: a quarter of the bar, a quarter of the video.
		await dragBy(page, zoomTab, bar.width / 4);
		const barPixel = 600 / bar.width;
		expect(Math.abs((await value(zoomFrom)) - 150)).toBeLessThanOrEqual(2 * barPixel + 0.001);
		expect((await value(zoomTo)) - (await value(zoomFrom))).toBeCloseTo(0.5, 3);
		await expectApartAndInReach(bar, zoomFrom, zoomTo);
		await zoomTab.press('End');
		await expect(zoomTab).toHaveAttribute('aria-valuetext', '9:59.5 to 10:00.0');

		// Zoomed in on 5.5 s from the start, the start stepped a second at a time out past it:
		// the timeline follows with room for its thumb, which still shows from its time.
		await zoomTab.press('Home');
		for (let i = 0; i < 5; i++) await zoomTo.press('Shift+ArrowRight');
		await expect(zoomTo).toHaveAttribute('aria-valuenow', '5.5');
		await start.press('Home');
		await expect(start).toHaveAttribute('aria-valuenow', '0');
		for (let k = 1; k <= 6; k++) {
			await start.press('Shift+ArrowRight');
			await expect(start).toHaveAttribute('aria-valuenow', String(k));
			const [viewFrom, viewTo] = [await value(zoomFrom), await value(zoomTo)];
			const shownAt = (time: number) =>
				box.x + ((time - viewFrom) / (viewTo - viewFrom)) * box.width;
			expect(Math.abs((await startsAt(start)) - shownAt(k)), `${k} s`).toBeLessThanOrEqual(1);
			expect(await endsAt(start)).toBeLessThanOrEqual(box.x + box.width + 0.5);
		}
		await expect(zoomTo).not.toHaveAttribute('aria-valuenow', '5.5');

		expect(await violations()).toEqual([]);
	});
});
