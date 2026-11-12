/**
 * Journeys with videos already on this device: imported into the library, or
 * opened straight from disk in the animation maker. Shared by the import spec
 * (a build with a relay) and the no-relay spec (VITE_RELAY_URL=none), where
 * they are all the app does.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FileChooser, Locator, Page } from '@playwright/test';
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
	// Its thumbnail is a still the browser took of it.
	await expect(card.locator('.thumb img')).toHaveCount(1);
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
