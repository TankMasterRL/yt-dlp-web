// @vitest-environment node
// Node's own Blob and MessageChannel: a Blob crosses the channel as it does between threads.
import { describe, expect, it } from 'vitest';
import { decodeGif } from '../../../tests/helpers/gif';
import { serveWorker } from '$lib/workers/protocol';
import {
	workerEncoder,
	workerFormats,
	type AnimateLoad,
	type AnimateResult,
	type AnimateWork,
	type FormatSupport
} from './client';
import { animateHandlers, probeFormats } from './encoder';

/** The animate worker's real handlers behind a MessageChannel, and whether it was stopped. */
function fakeWorker(probe?: () => Promise<FormatSupport>) {
	const { port1, port2 } = new MessageChannel();
	serveWorker<AnimateLoad, AnimateWork, AnimateResult, never>(animateHandlers({ probe }), port2);
	port2.start();
	const state = { terminated: false };
	const spawn = () =>
		Object.assign(port1, {
			terminate() {
				state.terminated = true;
				port1.close();
				port2.close();
			}
		});
	return { spawn, state };
}

const solid = (width: number, height: number, rgb: number[]) => {
	const out = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i++) out.set([...rgb, 255], i * 4);
	return out;
};

describe('workerEncoder', () => {
	it('encodes frames into a GIF in the worker, then stops it', async () => {
		const { spawn, state } = fakeWorker();
		const encoder = workerEncoder({ spawn });
		const [red, blue] = [solid(4, 2, [255, 0, 0]), solid(4, 2, [0, 0, 255])];
		await encoder.begin({ format: 'gif', width: 4, height: 2, fps: 20, quality: 75 }, [red, blue]);
		// Samples are copied, not handed over: they may be sent again as frames.
		expect(red.byteLength).toBe(4 * 2 * 4);
		await encoder.frame(red);
		expect(red.byteLength).toBe(0); // a frame's pixels are transferred
		await encoder.frame(blue);
		const blob = await encoder.finish();
		expect(blob.type).toBe('image/gif');
		const gif = decodeGif(new Uint8Array(await blob.arrayBuffer()));
		expect(gif).toMatchObject({ width: 4, height: 2 });
		expect(gif.frames.map((f) => [f.delay, ...f.canvas.subarray(0, 3)])).toEqual([
			[5, 255, 0, 0],
			[5, 0, 0, 255]
		]);
		expect(state.terminated).toBe(true);
	});

	it('closing stops the worker, and calls still waiting fail as aborted', async () => {
		const { spawn, state } = fakeWorker();
		const encoder = workerEncoder({ spawn });
		await encoder.begin({ format: 'gif', width: 1, height: 1, fps: 10, quality: 75 }, [
			solid(1, 1, [1, 2, 3])
		]);
		const waiting = encoder.frame(solid(1, 1, [1, 2, 3]));
		encoder.close();
		await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
		await expect(encoder.finish()).rejects.toMatchObject({ name: 'AbortError' });
		expect(state.terminated).toBe(true);
	});
});

describe('workerFormats', () => {
	it('asks a worker which formats it can make, then stops it', async () => {
		const support = { gif: true, webp: true, apng: true, avif: false, jxl: true };
		const { spawn, state } = fakeWorker(async () => support);
		expect(await workerFormats({ spawn })).toEqual(support);
		expect(state.terminated).toBe(true);
	});

	it('makes its own formats anywhere, and the browser’s only where it has the encoders', async () => {
		// Node has CompressionStream, but no OffscreenCanvas or WebCodecs.
		expect(await probeFormats()).toEqual({
			gif: true,
			webp: false,
			apng: true,
			avif: false,
			jxl: true
		});
	});
});

describe('animateHandlers', () => {
	it('wants a beginning before frames', async () => {
		const handlers = animateHandlers();
		const noProgress = () => {};
		const frame = async () =>
			handlers.work({ kind: 'frame', pixels: solid(1, 1, [0, 0, 0]) }, noProgress);
		await expect(frame()).rejects.toThrow(/begin/);
	});
});
