/**
 * Regenerate tests/fixtures/media/*.webm — tiny, real, playable VP8 clips for
 * the e2e download → library → playback tests. Chromium draws the frames (JPEG
 * from a canvas); Playwright's bundled ffmpeg (MJPEG in, VP8/WebM out, with
 * proper duration metadata) encodes them. WebM because Chromium builds without
 * proprietary codecs cannot play H.264.
 *
 * The output is committed; this script only needs re-running to change it:
 *   bun scripts/make-fixture-media.ts
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const OUT = join(import.meta.dir, '..', 'tests', 'fixtures', 'media');
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
const ffmpegDir = readdirSync(browsersPath).find((d) => d.startsWith('ffmpeg-'));
if (!ffmpegDir) throw new Error(`No Playwright ffmpeg under ${browsersPath}`);
const ffmpeg = join(browsersPath, ffmpegDir, 'ffmpeg-linux');

const prebuilt = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch(existsSync(prebuilt) ? { executablePath: prebuilt } : {});
const page = await browser.newPage();

async function renderFrames(width: number, height: number, frames: number, label: string) {
	const dataUrls: string[] = await page.evaluate(
		({ width, height, frames, label }) => {
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext('2d')!;
			const out: string[] = [];
			for (let i = 0; i < frames; i++) {
				ctx.fillStyle = `hsl(${(i * 360) / frames}, 70%, 45%)`;
				ctx.fillRect(0, 0, width, height);
				ctx.fillStyle = '#fff';
				ctx.font = `bold ${Math.round(height / 5)}px sans-serif`;
				ctx.fillText(`${label} ${i + 1}/${frames}`, width / 12, height / 2);
				out.push(canvas.toDataURL('image/jpeg', 0.8));
			}
			return out;
		},
		{ width, height, frames, label }
	);
	return Buffer.concat(dataUrls.map((u) => Buffer.from(u.split(',')[1], 'base64')));
}

mkdirSync(OUT, { recursive: true });
for (const [name, width, height] of [
	['bbf-360', 640, 360],
	['bbf-720', 1280, 720]
] as const) {
	const jpegs = await renderFrames(width, height, 24, `${height}p`);
	const target = join(OUT, `${name}.webm`);
	const run = spawnSync(
		ffmpeg,
		[
			'-y',
			'-f',
			'image2pipe',
			'-framerate',
			'12',
			'-c:v',
			'mjpeg',
			'-i',
			'pipe:0',
			'-c:v',
			'libvpx',
			'-b:v',
			'120k',
			'-an',
			'-f',
			'webm',
			target
		],
		{ input: jpegs }
	);
	if (run.status !== 0)
		throw new Error(`ffmpeg failed for ${name}: ${run.stderr.toString().slice(-800)}`);
	console.log(`✓ ${target}`);
}
await browser.close();
