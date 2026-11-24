/**
 * Journeys with files already on this device: videos imported into the
 * library or opened straight from disk in the animation maker, and animated
 * images opened in the viewer. Shared by the import spec (a build with a
 * relay) and the no-relay spec (VITE_RELAY_URL=none), where they are all the
 * app does.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FileChooser, Locator, Page } from '@playwright/test';
import { ApngEncoder } from '../../src/lib/animate/apng';
import { GifEncoder } from '../../src/lib/animate/gif';
import { JxlEncoder } from '../../src/lib/animate/jxl';
import { buildPalette } from '../../src/lib/animate/quantize';
import { formatBytes } from '../../src/lib/formats';
import { decodeGif, type DecodedGif } from '../helpers/gif';
import { expect } from './fixtures';
import { hasOpfs, opfsFiles, probe } from './app';

/** The fixture clip: 640×360, 2 s. */
export const FIXTURE_PATH = fileURLToPath(
	new URL('../fixtures/media/bbf-360.webm', import.meta.url)
);
const FIXTURE = readFileSync(FIXTURE_PATH);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Exercise the plain-download export path: showSaveFilePicker opens a native dialog automation cannot drive. */
export async function withoutSavePicker(page: Page): Promise<void> {
	await page.addInitScript(() => {
		delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
	});
}

/** Clicks `button` on the library page and picks `files` in the file dialog it opens. */
export async function pickFiles(
	page: Page,
	button: string,
	files: Parameters<FileChooser['setFiles']>[0]
): Promise<void> {
	const [chooser] = await Promise.all([
		page.waitForEvent('filechooser'),
		page.getByRole('button', { name: button }).click()
	]);
	await chooser.setFiles(files);
}

/**
 * In the open animation maker: makes a GIF of the default range (the whole
 * 2 s clip, 12 fps, 480 px wide), saves it under a name matching `name`,
 * closes the maker, and returns the GIF decoded.
 */
export async function makeGif(page: Page, name: RegExp): Promise<DecodedGif> {
	const dialog = page.getByRole('dialog', { name: 'Make an animated image' });
	// The editor knows the clip's length once the browser has read it.
	await expect(dialog.getByRole('slider', { name: 'End' })).toHaveAttribute('aria-valuemax', '2', {
		timeout: 15_000
	});
	await dialog.getByRole('button', { name: 'Create GIF' }).click();
	const result = dialog.getByRole('region', { name: 'Your GIF' });
	const failure = dialog.getByRole('alert');
	await expect(result.or(failure)).toBeVisible({ timeout: 90_000 });
	expect(await failure.allTextContents(), 'making the GIF').toEqual([]);
	// The whole clip at 12 fps is 24 frames taken (frames that change nothing fold into the one before).
	await expect(result).toContainText('480 × 270 px · 24 frames · 2.0 s');
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		result.getByRole('button', { name: 'Save GIF' }).click()
	]);
	expect(download.suggestedFilename()).toMatch(name);
	const saved = readFileSync(
		(await probe('wait for the saved GIF to download', () => download.path()))!
	);
	await dialog.getByRole('button', { name: 'Close the animation maker' }).click();
	return decodeGif(new Uint8Array(saved));
}

/** The GIF of the whole clip, named after the file (WebKit saves downloads with spaces as "_"). */
const GIF_NAME = /^bbf-360[ _]\(0\.0s-2\.0s\)\.gif$/;

/** The whole 2 s clip, 480 px wide, looping. */
function expectWholeClip(gif: DecodedGif): void {
	expect(gif).toMatchObject({ width: 480, height: 270, loop: 0 });
	// At the clip's own 12 fps, each of its 24 numbered pictures once: a picture taken
	// twice would fold into one GIF frame (it changes nothing), so any doubled or lost
	// picture shows as fewer. Taken at the times frames fall on, every few were doubled:
	// WebM rounds when pictures start to the millisecond (frame 2 at 167 ms, after 2/12 s).
	expect(gif.frames).toHaveLength(24);
	expect(gif.frames.reduce((sum, frame) => sum + frame.delay, 0)).toBe(200);
}

/**
 * Imports the fixture clip into the library and takes it all the way: it is
 * stored, plays, is saved back byte for byte under its own name, survives a
 * reload, becomes a GIF, and is deleted with its bytes. Call on a page whose
 * init scripts are in place (`withoutSavePicker`); returns false, having done
 * nothing, where the browser has no private file storage.
 */
export async function importJourney(page: Page): Promise<boolean> {
	await page.goto('/library/');
	if (!(await hasOpfs(page))) return false;
	await pickFiles(page, 'Import videos…', [FIXTURE_PATH]);

	// It is in the library, named after the file, stored in OPFS.
	const card: Locator = page.getByRole('article', { name: 'bbf-360' });
	await expect(card).toHaveAttribute('data-status', 'complete', { timeout: 30_000 });
	await expect(card).toContainText('Imported');
	await expect(card).toContainText('From this device');
	await expect(card).toContainText('360p');
	// Its thumbnail is a still the browser took of it: the picture, never the black a canvas
	// turns into when the browser drew nothing on it (WebKit, from a video outside the page).
	const thumbnail = card.locator('.thumb img');
	await expect(thumbnail).toHaveCount(1);
	const still = await probe('read the thumbnail', () =>
		thumbnail.evaluate(async (img: HTMLImageElement) => {
			await img.decode();
			const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
			const context = canvas.getContext('2d')!;
			context.drawImage(img, 0, 0);
			const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
			let sum = 0;
			for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
			return { width: canvas.width, height: canvas.height, mean: sum / (pixels.length / 4) / 3 };
		})
	);
	// 320 × 180, and as bright as the clip's frame at 0.2 s (about 135; black is 0).
	expect(still).toMatchObject({ width: 320, height: 180 });
	expect(still.mean).toBeGreaterThan(80);
	expect(await opfsFiles(page)).toHaveLength(1);

	// It plays: the browser decodes the stored copy.
	await card.getByRole('button', { name: 'Play bbf-360' }).click();
	const video = page.getByRole('dialog').locator('video');
	await expect
		.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15_000 })
		.toBe(640);
	await page.getByRole('button', { name: 'Close player' }).click();

	// Saved back, it is the very file that was picked, under its own name.
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		card.getByRole('button', { name: 'Save bbf-360 to disk' }).click()
	]);
	expect(download.suggestedFilename()).toBe('bbf-360.webm');
	const exported = readFileSync(
		(await probe('wait for the exported file to download', () => download.path()))!
	);
	expect(sha256(exported)).toBe(sha256(FIXTURE));

	// It survives a reload (IndexedDB metadata, OPFS bytes).
	await page.reload();
	await expect(card).toHaveAttribute('data-status', 'complete');

	// It becomes an animated image, named after the file.
	await card.getByRole('button', { name: 'Make an animated image from bbf-360' }).click();
	expectWholeClip(await makeGif(page, GIF_NAME));

	// Delete asks once, then removes the record and the bytes.
	await card.getByRole('button', { name: 'Delete bbf-360' }).click();
	await page.getByRole('button', { name: /^Confirm deleting/ }).click();
	await expect(page.getByRole('article')).toHaveCount(0);
	expect(await opfsFiles(page)).toEqual([]);
	return true;
}

/**
 * Opens the fixture clip straight from disk in the animation maker and makes
 * a GIF of it: nothing lands in the library, nothing is copied — so it works
 * without private file storage too.
 */
export async function animateFromDisk(page: Page): Promise<void> {
	await page.goto('/library/');
	await pickFiles(page, 'Animate a video file…', [FIXTURE_PATH]);
	const dialog = page.getByRole('dialog', { name: 'Make an animated image' });
	await expect(dialog).toContainText('bbf-360');
	expectWholeClip(await makeGif(page, GIF_NAME));
	await expect(page.getByRole('article')).toHaveCount(0);
	if (await hasOpfs(page)) expect(await opfsFiles(page)).toEqual([]);
}

/** `count` width × height frames, each one color, each another. */
function colorFrames(width: number, height: number, count: number): Uint8ClampedArray[] {
	return Array.from({ length: count }, (_, i) => {
		const frame = new Uint8ClampedArray(width * height * 4);
		for (let p = 0; p < frame.length; p += 4) frame.set([(i * 50) % 256, 255 - i * 40, 90, 255], p);
		return frame;
	});
}

/**
 * Animated images as files on the device, made here by the app's own encoders
 * (so nothing is made in the browser): a GIF of 6 frames of 10 cs, an APNG of
 * 4 at 8 fps and a JPEG XL of 3 at 5 fps.
 */
async function imageFiles(): Promise<{ name: string; mimeType: string; buffer: Buffer }[]> {
	const gifFrames = colorFrames(160, 90, 6);
	const gif = new GifEncoder({ width: 160, height: 90, palette: buildPalette(gifFrames) });
	for (const frame of gifFrames) gif.addFrame(frame, 10);
	const apng = new ApngEncoder({ width: 120, height: 80, fps: 8 });
	for (const frame of colorFrames(120, 80, 4)) await apng.addFrame(frame);
	const jxl = new JxlEncoder({ width: 64, height: 48, fps: 5 });
	for (const frame of colorFrames(64, 48, 3)) jxl.addFrame(frame);
	return [
		{ name: 'moving.gif', mimeType: 'image/gif', buffer: Buffer.concat(gif.finish()) },
		{ name: 'moving.png', mimeType: 'image/png', buffer: Buffer.concat(await apng.finish()) },
		{ name: 'moving.jxl', mimeType: 'image/jxl', buffer: Buffer.concat(jxl.finish()) }
	];
}

/**
 * Opens animated images straight from disk in the viewer, without making
 * them: each is shown at its own size with what its headers say, the viewer
 * steps through them, and a video picked by mistake is refused. Nothing is
 * stored or sent anywhere — so it works without private file storage, and
 * without a relay.
 */
export async function viewFromDisk(page: Page): Promise<void> {
	const requests: string[] = [];
	page.on('request', (request) => requests.push(request.url()));
	await page.goto('/library/');
	const own = new URL(page.url()).origin;
	const files = await imageFiles();
	await pickFiles(page, 'View animated images…', [
		...files,
		{ name: 'bbf-360.webm', mimeType: 'video/webm', buffer: FIXTURE }
	]);
	await expect(page.getByRole('alert')).toHaveText(
		"bbf-360.webm can't be viewed: it isn't a GIF, PNG, WebP, AVIF or JPEG XL image"
	);

	const viewer = page.getByRole('dialog');
	const image = viewer.getByRole('img');
	/** The width the browser decoded the image at; 'unshowable' if it can't decode it. */
	const shown = () =>
		viewer.evaluate((dialog) => {
			if (dialog.querySelector('[data-unshowable]')) return 'unshowable';
			const img = dialog.querySelector('img');
			return img?.complete ? img.naturalWidth : 0;
		});
	const bytes = (i: number) => formatBytes(files[i].buffer.length);

	// The first, named after its file, at its own size: the person's own file, so neither
	// Save nor Remove.
	await expect(viewer).toHaveAccessibleName('moving.gif');
	await expect(viewer).toContainText('GIF from this device');
	await expect(viewer).toContainText(`160 × 90 px · 6 frames · 0.6 s · ${bytes(0)}`);
	await expect(viewer).toContainText('1 of 3');
	await expect(image).toHaveAccessibleName('The animated GIF moving.gif');
	await expect.poll(shown).toBe(160);
	expect((await image.boundingBox())!.width).toBeCloseTo(160, 0);
	await expect(viewer.getByRole('button', { name: /^Save/ })).toHaveCount(0);
	await expect(viewer.getByRole('button', { name: 'Remove' })).toHaveCount(0);

	await viewer.getByRole('button', { name: 'Next animation' }).click();
	await expect(viewer).toHaveAccessibleName('moving.png');
	await expect(viewer).toContainText('APNG from this device');
	await expect(viewer).toContainText(`120 × 80 px · 4 frames · 0.5 s · ${bytes(1)}`);
	await expect.poll(shown).toBe(120);

	// JPEG XL: shown where the browser can (Chromium behind its flag), said so where it can't.
	await page.keyboard.press('ArrowRight');
	await expect(viewer).toHaveAccessibleName('moving.jxl');
	await expect(viewer).toContainText(`64 × 48 px · 3 frames · 0.6 s · ${bytes(2)}`);
	await expect.poll(shown).not.toBe(0);
	if ((await shown()) === 'unshowable') {
		await expect(viewer.locator('[data-unshowable]')).toHaveText(
			"This browser can't show this JPEG XL image. Open it with a browser or viewer that can."
		);
	} else {
		expect(await shown()).toBe(64);
	}

	// Round from the last to the first.
	await page.keyboard.press('ArrowRight');
	await expect(viewer).toHaveAccessibleName('moving.gif');
	await viewer.getByRole('button', { name: 'Close the animation viewer' }).click();
	await expect(viewer).toHaveCount(0);

	// Looked at, and kept nowhere: not in the library, not among the animations made here,
	// not in private storage, and sent to no one.
	await expect(page.getByRole('article')).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Animations' })).toHaveCount(0);
	if (await hasOpfs(page)) expect(await opfsFiles(page)).toEqual([]);
	expect(requests.filter((url) => /^https?:/.test(url) && !url.startsWith(own))).toEqual([]);
}
