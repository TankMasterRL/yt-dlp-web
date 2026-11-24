// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { GifEncoder } from './gif';
import { IMAGE_FILES, imageLabel, openImage, viewOpened } from './opened';
import { buildPalette } from './quantize';

type RGB = [number, number, number];

function solid(width: number, height: number, [r, g, b]: RGB): Uint8ClampedArray {
	const out = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < out.length; i += 4) out.set([r, g, b, 255], i);
	return out;
}

/** A 12 × 8 GIF of `colors`, 10 cs each. */
function gif(colors: RGB[]): Uint8Array<ArrayBuffer> {
	const frames = colors.map((c) => solid(12, 8, c));
	const encoder = new GifEncoder({ width: 12, height: 8, palette: buildPalette(frames) });
	for (const frame of frames) encoder.addFrame(frame, 10);
	const chunks = encoder.finish();
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	chunks.reduce((at, c) => (out.set(c, at), at + c.length), 0);
	return out;
}

const ANIMATED = gif([
	[255, 0, 0],
	[0, 255, 0],
	[0, 0, 255]
]);

const bytes = (text: string) => [...text].map((c) => c.charCodeAt(0));
const u32be = (n: number) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
/** A still PNG: signature, IHDR, IDAT and IEND (no CRCs: headers are all that is read). */
const STILL_PNG = Uint8Array.from([
	...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
	...u32be(13),
	...bytes('IHDR'),
	...u32be(32),
	...u32be(16),
	8,
	6,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	...u32be(0),
	...bytes('IEND'),
	0,
	0,
	0,
	0
]);

describe('openImage', () => {
	it('reads what a file says of itself, and gives each opening an id of its own', async () => {
		const file = new File([ANIMATED], 'party.gif', { type: 'image/gif' });
		const opened = await openImage(file);
		expect(opened.file).toBe(file);
		expect(opened.info).toEqual({
			format: 'gif',
			animated: true,
			width: 12,
			height: 8,
			frames: 3,
			duration: 0.3
		});
		expect((await openImage(file)).id).not.toBe(opened.id);
	});

	it('goes by the bytes, never the name or the type', async () => {
		const misnamed = new File([ANIMATED], 'party.png', { type: 'image/png' });
		expect((await openImage(misnamed)).info.format).toBe('gif');
	});

	it('refuses anything else having read only its first bytes, saying why', async () => {
		const video = new File([new Uint8Array(1 << 20)], 'clip.gif', { type: 'image/gif' });
		const whole = vi.spyOn(video, 'arrayBuffer');
		await expect(openImage(video)).rejects.toThrow(
			"it isn't a GIF, PNG, WebP, AVIF or JPEG XL image"
		);
		expect(whole).not.toHaveBeenCalled();
	});

	it('refuses an image whose header is past reading', async () => {
		const cut = new File([STILL_PNG.subarray(0, 12)], 'cut.png');
		await expect(openImage(cut)).rejects.toThrow(
			"it seems to be a PNG, but its header can't be read"
		);
	});

	it('offers the five formats in the file picker', () => {
		for (const accepted of [
			'image/gif',
			'image/png',
			'image/webp',
			'image/avif',
			'image/jxl',
			'.jxl'
		])
			expect(IMAGE_FILES.split(',')).toContain(accepted);
	});
});

describe('viewOpened', () => {
	it('names an animation by its file, and says all its headers say', async () => {
		const opened = await openImage(new File([ANIMATED], 'party.gif'));
		expect(viewOpened(opened)).toEqual({
			id: opened.id,
			blob: opened.file,
			width: 12,
			height: 8,
			title: 'party.gif',
			what: 'GIF from this device',
			alt: 'The animated GIF party.gif',
			details: `12 × 8 px · 3 frames · 0.3 s · ${ANIMATED.length} B`,
			label: 'GIF',
			unshowable:
				"This browser can't show this GIF image. Open it with a browser or viewer that can.",
			// The person's own file: there is nothing to save.
			fileName: null
		});
	});

	it('calls a still PNG a PNG, of one frame and no length', async () => {
		const opened = await openImage(new File([STILL_PNG], 'logo.png'));
		expect(imageLabel(opened.info)).toBe('PNG');
		expect(viewOpened(opened)).toMatchObject({
			what: 'PNG from this device',
			alt: 'The PNG logo.png',
			details: `32 × 16 px · 1 frame · ${STILL_PNG.length} B`,
			label: 'PNG'
		});
	});

	it('says an animation is one when its frames could not be counted', () => {
		const file = new File(['…'], 'walk.jxl');
		const info = {
			format: 'jxl',
			animated: true,
			width: 4,
			height: 3,
			frames: null,
			duration: null
		} as const;
		expect(viewOpened({ id: 'opened-x', file, info }).details).toBe('4 × 3 px · animated · 3 B');
		expect(imageLabel({ ...info, format: 'apng' })).toBe('APNG');
	});
});
