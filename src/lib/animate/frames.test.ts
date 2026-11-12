import { describe, expect, it } from 'vitest';
import { frameTimes, type TimeRange } from './clip';
import {
	learnGrid,
	mediaMetadata,
	seek,
	videoFrames,
	videoMetadata,
	type FrameCanvas,
	type SeekableVideo
} from './frames';
import { frameRate } from './grid';

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
	callbacks: ((now: number, picture: { mediaTime: number }) => void)[] = [];
	constructor(readonly lag: number | null) {
		super();
	}

	requestVideoFrameCallback(callback: (now: number, picture: { mediaTime: number }) => void) {
		this.callbacks.push(callback);
		return this.callbacks.length;
	}

	protected override present() {
		if (this.lag === null) return;
		setTimeout(() => {
			super.present();
			for (const callback of this.callbacks.splice(0))
				callback(performance.now(), { mediaTime: this.shown });
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

/** When picture k starts, as WebM and Matroska store it: in whole milliseconds. */
const webmStarts = (fps: number, count: number) =>
	Array.from({ length: count }, (_, k) => Math.round((k * 1000) / fps) / 1000);

/**
 * A video of real pictures: picture k is on screen from `starts[k]` until the
 * next one starts. A seek shows the last one starting at or before the time,
 * as Chromium and Firefox do. Played, it shows each picture in turn (a
 * millisecond apart, whatever the rate) and reports when it starts; after a
 * seek it reports the time sought instead, as Firefox and WebKit do.
 */
class FramedVideo extends EventTarget implements SeekableVideo {
	#time = 0;
	picture = 0;
	seeking = false;
	readyState = 4;
	error = null;
	videoWidth = 640;
	videoHeight = 360;
	duration: number;
	playbackRate = 1;
	paused = true;
	ended = false;
	seeks: number[] = [];
	#callbacks = new Map<number, (now: number, metadata: { mediaTime: number }) => void>();
	#nextCallback = 1;
	#ticking: ReturnType<typeof setInterval> | undefined;

	constructor(
		readonly starts: number[],
		/** Whether it reports pictures at all (requestVideoFrameCallback). */
		reports = true
	) {
		super();
		this.duration = starts.at(-1)! + (starts.at(-1)! - starts.at(-2)!);
		if (!reports) this.requestVideoFrameCallback = undefined;
	}

	get currentTime() {
		return this.#time;
	}

	set currentTime(time: number) {
		this.seeks.push(time);
		this.seeking = true;
		setTimeout(() => {
			this.#time = Math.min(Math.max(time, 0), this.duration);
			this.picture = this.#pictureAt(this.#time);
			this.ended = false;
			this.seeking = false;
			this.dispatchEvent(new Event('seeked'));
			this.#report(this.#time);
		}, 1);
	}

	#pictureAt(time: number): number {
		let k = 0;
		while (k + 1 < this.starts.length && this.starts[k + 1] <= time) k++;
		return k;
	}

	#report(mediaTime: number) {
		const callbacks = [...this.#callbacks.values()];
		this.#callbacks.clear();
		for (const callback of callbacks) callback(performance.now(), { mediaTime });
	}

	requestVideoFrameCallback?: (
		callback: (now: number, metadata: { mediaTime: number }) => void
	) => number = (callback) => {
		const handle = this.#nextCallback++;
		this.#callbacks.set(handle, callback);
		return handle;
	};

	cancelVideoFrameCallback(handle: number) {
		this.#callbacks.delete(handle);
	}

	async play() {
		this.paused = false;
		// The picture already on screen comes first, reported at the time sought.
		let first = true;
		this.#ticking = setInterval(() => {
			if (first) {
				first = false;
				return this.#report(this.#time);
			}
			if (this.picture + 1 >= this.starts.length) {
				this.pause();
				this.ended = true;
				return this.dispatchEvent(new Event('ended'));
			}
			this.picture++;
			this.#time = this.starts[this.picture];
			this.#report(this.#time);
		}, 1);
	}

	pause() {
		this.paused = true;
		clearInterval(this.#ticking);
	}
}

/** A canvas whose pixels say which of the video's pictures was on screen. */
function pictureCanvas(video: FramedVideo): FrameCanvas {
	return {
		width: 0,
		height: 0,
		getContext: () => ({
			imageSmoothingEnabled: false,
			imageSmoothingQuality: 'low',
			drawImage: () => {},
			getImageData: (_x: number, _y: number, width: number, height: number) => {
				const data = new Uint8Array(width * height * 4);
				new DataView(data.buffer).setUint16(0, video.picture);
				return { data: new Uint8ClampedArray(data.buffer) };
			}
		})
	};
}

/** Which of the video's pictures an animation of `range` at `fps` is made of. */
async function picturesTaken(video: FramedVideo, range: TimeRange, fps: number) {
	const frames = videoFrames(
		video as unknown as SeekableVideo & CanvasImageSource,
		pictureCanvas(video)
	);
	await frames.prepare?.(range);
	const taken: number[] = [];
	const crop = { x: 0, y: 0, width: 4, height: 4 };
	for (const time of frameTimes(range, fps)) {
		const pixels = await frames.frameAt(time, crop, { width: 2, height: 2 });
		taken.push(new DataView(pixels.buffer).getUint16(0));
	}
	return taken;
}

const steps = (pictures: number[]) => pictures.slice(1).map((p, i) => p - pictures[i]);

describe('frames at even steps', () => {
	it('take every picture of a WebM once at its own rate, though WebM rounds when they start', async () => {
		const video = new FramedVideo(webmStarts(30, 120));
		expect(await picturesTaken(video, { start: 0, end: 2 }, 30)).toEqual(
			Array.from({ length: 60 }, (_, k) => k)
		);
	});

	it('take every other picture at half its rate, from wherever the range starts', async () => {
		const video = new FramedVideo(webmStarts(60, 240));
		const taken = await picturesTaken(video, { start: 0.708, end: 2.708 }, 30);
		expect(taken[0]).toBe(42);
		expect(new Set(steps(taken))).toEqual(new Set([2]));
	});

	it('alternate two and three pictures where the rates do not divide (30 fps at 12)', async () => {
		const video = new FramedVideo(webmStarts(30, 120));
		const taken = await picturesTaken(video, { start: 0, end: 2 }, 12);
		expect(steps(taken)).toEqual(Array.from({ length: 23 }, (_, i) => (i % 2 ? 3 : 2)));
	});

	it('hold one picture twice in 20 s at 30 fps of a 29.97 fps WebM, and no more', async () => {
		const video = new FramedVideo(webmStarts(30000 / 1001, 700));
		const taken = await picturesTaken(video, { start: 1, end: 21 }, 30);
		expect(taken).toHaveLength(600);
		const counts = steps(taken).reduce<Record<number, number>>(
			(all, step) => ({ ...all, [step]: (all[step] ?? 0) + 1 }),
			{}
		);
		expect(counts).toEqual({ 0: 1, 1: 598 });
	});

	it('take the times asked when the browser reports no pictures', async () => {
		const video = new FramedVideo(webmStarts(30, 120), false);
		await picturesTaken(video, { start: 0.1, end: 0.3 }, 30);
		expect(video.seeks).toEqual(frameTimes({ start: 0.1, end: 0.3 }, 30));
	});
});

describe('learnGrid', () => {
	it("learns a video's rate from a moment of it playing, and leaves it paused as it was", async () => {
		const video = new FramedVideo(webmStarts(30000 / 1001, 120));
		video.playbackRate = 1.5;
		// Four seconds: long enough to tell 29.97 fps from 30.
		const grid = (await learnGrid(video, { start: 0, end: 4 }))!;
		expect(frameRate(grid)).toBeCloseTo(29.97, 2);
		expect(video.paused).toBe(true);
		expect(video.playbackRate).toBe(1.5);
	});

	it('finds no grid in pictures that keep no steady rate', async () => {
		const video = new FramedVideo([0, 0.031, 0.069, 0.093, 0.141, 0.162, 0.215, 0.24, 0.291, 0.32]);
		expect(await learnGrid(video, { start: 0, end: 0.3 })).toBeNull();
	});

	it('stops when aborted', async () => {
		const video = new FramedVideo(webmStarts(30, 120));
		const controller = new AbortController();
		const learning = learnGrid(video, { start: 0, end: 1 }, controller.signal);
		controller.abort(new DOMException('cancelled', 'AbortError'));
		await expect(learning).rejects.toMatchObject({ name: 'AbortError' });
		expect(video.paused).toBe(true);
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
