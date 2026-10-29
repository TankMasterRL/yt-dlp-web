import { describe, expect, it } from 'vitest';
import { seek, videoFrames, videoMetadata, type FrameCanvas, type SeekableVideo } from './frames';

/** A media element that seeks (asynchronously, like a real one) and can fail. */
class FakeVideo extends EventTarget implements SeekableVideo {
	#time = 0;
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
		}, 1);
	}

	fail(code: number, message = '') {
		this.error = { code, message };
		this.dispatchEvent(new Event('error'));
	}
}

/** A canvas whose pixels say when they were drawn: red = what time the video was at. */
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
				for (let i = 0; i < data.length; i += 4) data[i] = video.currentTime * 100;
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
