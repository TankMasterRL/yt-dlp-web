// @vitest-environment node
// Node's Blob, which reads back its bytes; nothing here touches the DOM.
import { describe, expect, it, vi } from 'vitest';
import { decodeGif } from '../../../tests/helpers/gif';
import { MAX_FRAMES, type Rect, type Size } from './clip';
import { AnimationEditor, type AnimationEncoder } from './editor.svelte';
import type { FrameSource } from './frames';
import { GifEncoder } from './gif';
import { buildPalette } from './quantize';

/** The real GIF encoder, in this thread, recording what it was asked. */
function inThreadEncoder() {
	let gif: GifEncoder | null = null;
	const calls: string[] = [];
	const encoder: AnimationEncoder & { calls: string[] } = {
		calls,
		async begin(size, samples) {
			calls.push(`begin ${size.width}x${size.height} from ${samples.length}`);
			gif = new GifEncoder({ ...size, palette: buildPalette(samples) });
		},
		async frame(pixels, delay) {
			calls.push(`frame ${delay}`);
			gif!.addFrame(pixels, delay);
		},
		async finish() {
			calls.push('finish');
			return new Blob(gif!.finish(), { type: 'image/gif' });
		},
		close: vi.fn(() => void calls.push('close'))
	};
	return encoder;
}

/** Frames whose red says when they were taken (tenths of a second) and green where. */
function fakeSource(options: { fail?: Error; hold?: Promise<void> } = {}) {
	const requests: { time: number; crop: Rect; size: Size }[] = [];
	const source: FrameSource & { requests: typeof requests } = {
		requests,
		async frameAt(time, crop, size, signal) {
			requests.push({ time, crop: { ...crop }, size: { ...size } });
			if (options.hold) await options.hold;
			signal?.throwIfAborted();
			if (options.fail) throw options.fail;
			const out = new Uint8ClampedArray(size.width * size.height * 4);
			for (let i = 0; i < out.length; i += 4) out.set([Math.round(time * 10), crop.x, 0, 255], i);
			return out;
		}
	};
	return source;
}

const media = { width: 640, height: 360, duration: 12 };

function setup() {
	const encoders: ReturnType<typeof inThreadEncoder>[] = [];
	const editor = new AnimationEditor(() => {
		const encoder = inThreadEncoder();
		encoders.push(encoder);
		return encoder;
	});
	editor.setMedia(media);
	return { editor, encoders };
}

describe('AnimationEditor', () => {
	it('starts with the first seconds of the whole picture, at a sensible size', () => {
		const { editor } = setup();
		expect(editor.range).toEqual({ start: 0, end: 5 });
		expect(editor.crop).toEqual({ x: 0, y: 0, width: 640, height: 360 });
		expect(editor.size).toEqual({ width: 480, height: 270 });
		expect(editor.frameCount).toBe(5 * editor.fps);
		expect(editor.tooLong).toBe(false);
	});

	it('makes a GIF of the chosen range and crop, at the chosen rate and width', async () => {
		const { editor, encoders } = setup();
		editor.range = { start: 0.5, end: 1.5 };
		editor.crop = { x: 100, y: 40, width: 320, height: 160 };
		editor.fps = 10;
		editor.width = 160;
		const source = fakeSource();
		const done = editor.render(source);
		expect(editor.rendering).toBe(true);
		await done;

		// Each frame was taken once, in order, cropped and scaled.
		expect(source.requests.map((r) => r.time).sort()).toEqual([
			0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4
		]);
		expect(new Set(source.requests.map((r) => JSON.stringify([r.crop, r.size])))).toEqual(
			new Set([JSON.stringify([editor.crop, { width: 160, height: 80 }])])
		);
		expect(encoders[0].calls).toEqual([
			'begin 160x80 from 10',
			...Array(10).fill('frame 10'),
			'finish',
			'close'
		]);

		const result = editor.result!;
		expect(result).toMatchObject({ width: 160, height: 80, frames: 10, duration: 1 });
		const gif = decodeGif(new Uint8Array(await result.blob.arrayBuffer()));
		expect(gif.frames.map((f) => [f.canvas[0], f.canvas[1]])).toEqual(
			[5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((tenths) => [tenths, 100])
		);
		expect(editor.rendering).toBe(false);
		expect(editor.progress).toBeNull();
	});

	it('builds the palette from frames spread over the range, and does not take them twice', async () => {
		const { editor, encoders } = setup();
		editor.range = { start: 0, end: 10 };
		editor.fps = 10;
		const source = fakeSource();
		await editor.render(source);
		expect(encoders[0].calls[0]).toBe('begin 480x270 from 16');
		expect(source.requests).toHaveLength(100);
		expect(new Set(source.requests.map((r) => r.time)).size).toBe(100);
	});

	it('reports progress frame by frame', async () => {
		const { editor } = setup();
		editor.range = { start: 0, end: 0.5 };
		editor.fps = 10;
		let release!: () => void;
		const hold = new Promise<void>((resolve) => (release = resolve));
		const rendering = editor.render(fakeSource({ hold }));
		expect(editor.progress).toEqual({ done: 0, total: 5 });
		release();
		await rendering;
		expect(editor.progress).toBeNull();
		expect(editor.result?.frames).toBe(5);
	});

	it('can be cancelled: no result, no error, the encoder stopped', async () => {
		const { editor, encoders } = setup();
		let release!: () => void;
		const hold = new Promise<void>((resolve) => (release = resolve));
		const rendering = editor.render(fakeSource({ hold }));
		editor.cancel();
		release();
		await rendering;
		expect(editor).toMatchObject({ result: null, error: null, rendering: false });
		expect(encoders[0].close).toHaveBeenCalled();
	});

	it('says why when it fails', async () => {
		const { editor } = setup();
		await editor.render(
			fakeSource({ fail: new Error("This browser can't play this video's format") })
		);
		expect(editor.error).toBe("This browser can't play this video's format");
		expect(editor.result).toBeNull();
	});

	it('refuses ranges of too many frames', async () => {
		const { editor, encoders } = setup();
		editor.setMedia({ ...media, duration: 600 });
		editor.range = { start: 0, end: 100 };
		editor.fps = 30;
		expect(editor.frameCount).toBeGreaterThan(MAX_FRAMES);
		expect(editor.tooLong).toBe(true);
		await editor.render(fakeSource());
		expect(encoders).toHaveLength(0);
	});

	it('starts afresh for another video', () => {
		const { editor } = setup();
		editor.range = { start: 3, end: 4 };
		editor.crop = { x: 1, y: 1, width: 20, height: 20 };
		editor.setMedia({ width: 320, height: 240, duration: 3 });
		expect(editor.range).toEqual({ start: 0, end: 3 });
		expect(editor.crop).toEqual({ x: 0, y: 0, width: 320, height: 240 });
	});
});
