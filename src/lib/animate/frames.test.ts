import { describe, expect, it } from 'vitest';
import {
	mediaMetadata,
	seek,
	videoFrames,
	videoMetadata,
	type FrameCanvas,
	type SeekableVideo
} from './frames';

/**
 * A media element that seeks (asynchronously, like a real one) and can fail.
 * `shown` is the time of the picture on screen, which is what a canvas draws.
 */
class FakeVideo extends EventTarget implements SeekableVideo {
	#time = 0;
	shown = 0;
	seeking = false;
	readyState = 4;
	error: { code: number; message: string } | null = null;
	duration = 2;
	videoWidth = 640;
	videoHeight = 360;
	seeks: number[] = [];
	/** When false, seeks never finish (until the test fails or aborts them). */
	answers = true;

	get currentTime() {
		return this.#time;
	}

	set currentTime(time: number) {
		this.seeks.push(time);
		this.seeking = true;
		if (!this.answers) return;
		setTimeout(() => {
			this.#time = Math.min(time, Number.isFinite(this.duration) ? this.duration : 2);
			if (!Number.isFinite(this.duration) && time > 2) this.duration = 2;
			this.seeking = false;
			this.dispatchEvent(new Event('seeked'));
			this.present();
		}, 1);
	}

	/** Puts the seeked picture on screen (without frame callbacks, at once). */
	protected present() {
		this.shown = this.#time;
	}

	fail(code: number, message = '') {
		this.error = { code, message };
		this.dispatchEvent(new Event('error'));
	}
}

/**
 * A video that, like Chromium's, can report `seeked` before the new picture
 * is on screen: it arrives `lag` ms later, with a frame callback — or never.
 */
class LaggingVideo extends FakeVideo {
	callbacks: (() => void)[] = [];
	constructor(readonly lag: number | null) {
		super();
	}

	requestVideoFrameCallback(callback: () => void): number {
		this.callbacks.push(callback);
		return this.callbacks.length;
	}

	protected override present() {
		if (this.lag === null) return;
		setTimeout(() => {
			super.present();
			for (const callback of this.callbacks.splice(0)) callback();
		}, this.lag);
	}
}

/** A canvas whose pixels say what was on screen: red = the time of the picture shown. */
function fakeCanvas(video: FakeVideo) {
	const draws: unknown[][] = [];
	const canvas: FrameCanvas & { draws: unknown[][] } = {
		width: 0,
		height: 0,
		draws,
		getContext: () => ({
			imageSmoothingEnabled: false,
			imageSmoothingQuality: 'low',
			drawImage: (...args: unknown[]) => void draws.push(args.slice(1)),
			getImageData: (_x: number, _y: number, width: number, height: number) => {
				const data = new Uint8ClampedArray(width * height * 4);
				for (let i = 0; i < data.length; i += 4) data[i] = video.shown * 100;
				return { data };
			}
		})
	};
	return canvas;
}

describe('videoFrames', () => {
	it('seeks, then draws the crop at the output size and reads its pixels back', async () => {
		const video = new FakeVideo();
		const canvas = fakeCanvas(video);
		const frames = videoFrames(video as unknown as SeekableVideo & CanvasImageSource, canvas);
		const pixels = await frames.frameAt(
			0.5,
			{ x: 10, y: 20, width: 320, height: 180 },
			{ width: 160, height: 90 }
		);
		expect(video.seeks).toEqual([0.5]);
		expect(canvas).toMatchObject({ width: 160, height: 90 });
		expect(canvas.draws).toEqual([[10, 20, 320, 180, 0, 0, 160, 90]]);
		expect(pixels).toHaveLength(160 * 90 * 4);
		expect(pixels[0]).toBe(50);
	});

	it('waits for the new picture to be on screen, not just for the seek', async () => {
		const video = new LaggingVideo(20);
		const frames = videoFrames(
			video as unknown as SeekableVideo & CanvasImageSource,
			fakeCanvas(video)
		);
		const crop = { x: 0, y: 0, width: 4, height: 4 };
		const pixels = await frames.frameAt(0.7, crop, { width: 2, height: 2 });
		expect(pixels[0]).toBe(70);
	});

	it('takes the picture anyway when no new one is ever shown', async () => {
		const video = new LaggingVideo(null);
		video.shown = 0.3;
		const started = performance.now();
		await seek(video, 0.7, undefined, 30);
		expect(performance.now() - started).toBeGreaterThanOrEqual(25);
	});

	it('does not seek to where the video already is', async () => {
		const video = new FakeVideo();
		await seek(video, 1);
		video.answers = false; // a seek now would never finish
		await seek(video, 1);
		expect(video.seeks).toEqual([1]);
	});

	it('fails when the video cannot be decoded', async () => {
		const video = new FakeVideo();
		video.answers = false;
		const seeking = seek(video, 1);
		video.fail(4);
		await expect(seeking).rejects.toThrow("This browser can't play this video's format");
	});

	it('stops waiting when aborted', async () => {
		const video = new FakeVideo();
		video.answers = false;
		const controller = new AbortController();
		const seeking = seek(video, 1, controller.signal);
		controller.abort(new DOMException('cancelled', 'AbortError'));
		await expect(seeking).rejects.toMatchObject({ name: 'AbortError' });
		await expect(seek(video, 1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
	});
});

describe('videoMetadata', () => {
	it("reads the video's size and length once its metadata is in", async () => {
		const video = new FakeVideo();
		video.readyState = 0;
		const metadata = videoMetadata(video);
		video.readyState = 1;
		video.dispatchEvent(new Event('loadedmetadata'));
		expect(await metadata).toEqual({ width: 640, height: 360, duration: 2 });
	});

	it('finds the length of a file that does not state it, by seeking to its end', async () => {
		const video = new FakeVideo();
		video.duration = Infinity;
		expect(await videoMetadata(video)).toEqual({ width: 640, height: 360, duration: 2 });
		expect(video.currentTime).toBe(0);
	});

	it('fails for a file with no picture', async () => {
		const video = new FakeVideo();
		video.videoWidth = 0;
		await expect(videoMetadata(video)).rejects.toThrow(/no picture/);
	});
});

describe('mediaMetadata', () => {
	it('reads sound without a picture as 0 × 0', async () => {
		const video = new FakeVideo();
		video.videoWidth = video.videoHeight = 0;
		expect(await mediaMetadata(video)).toEqual({ width: 0, height: 0, duration: 2 });
	});

	it('fails as the browser does for a file it cannot play', async () => {
		const video = new FakeVideo();
		video.readyState = 0;
		const metadata = mediaMetadata(video);
		video.fail(4);
		await expect(metadata).rejects.toThrow("This browser can't play this video's format");
	});

	it('gives up when told to, for a file the browser never answers about', async () => {
		const video = new FakeVideo();
		video.readyState = 0;
		const controller = new AbortController();
		const metadata = mediaMetadata(video, controller.signal);
		controller.abort(new DOMException('signal timed out', 'TimeoutError'));
		await expect(metadata).rejects.toMatchObject({ name: 'TimeoutError' });
	});
});
