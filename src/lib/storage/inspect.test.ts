import { describe, expect, it, vi } from 'vitest';
import type { OpenedVideo, SeekableVideo } from '$lib/animate/frames';
import { THUMBNAIL_WIDTH, inspectFile, inspectMedia, type StillCanvas } from './inspect';

/** A loaded media element that seeks at once. */
class FakeMedia extends EventTarget implements SeekableVideo {
	#time = 0;
	seeking = false;
	readyState = 4;
	error: { code: number; message: string } | null = null;
	duration = 40;
	videoWidth = 1280;
	videoHeight = 720;

	get currentTime() {
		return this.#time;
	}

	set currentTime(time: number) {
		this.seeking = true;
		setTimeout(() => {
			this.#time = time;
			this.seeking = false;
			this.dispatchEvent(new Event('seeked'));
		}, 1);
	}
}

/**
 * A canvas that notes what is drawn on it, and when. Its pixels are opaque
 * once something is drawn — unless `blank`, as WebKit leaves a canvas it
 * was asked to draw a detached video on.
 */
function fakeCanvas(
	blob: Blob | null = new Blob(['jpg'], { type: 'image/jpeg' }),
	{ blank = false } = {}
) {
	const draws: { at: number; size: number[] }[] = [];
	let video: FakeMedia;
	const canvas: StillCanvas & { draws: typeof draws; watch(v: FakeMedia): void } = {
		width: 0,
		height: 0,
		draws,
		watch: (v) => (video = v),
		getContext: () => ({
			drawImage: (_image: CanvasImageSource, ...size: number[]) =>
				void draws.push({ at: video.currentTime, size }),
			getImageData: (_x: number, _y: number, width: number, height: number) => {
				const data = new Uint8ClampedArray(width * height * 4);
				if (draws.length && !blank) data.fill(255);
				return { data };
			}
		}),
		toBlob: vi.fn((callback: BlobCallback) => setTimeout(() => callback(blob), 0))
	};
	return canvas;
}

describe('inspectMedia', () => {
	it("reads the video's size and length, and takes a still a tenth of the way in", async () => {
		const video = new FakeMedia();
		const canvas = fakeCanvas();
		canvas.watch(video);
		const facts = await inspectMedia(video as unknown as SeekableVideo & CanvasImageSource, canvas);
		expect(facts).toMatchObject({ width: 1280, height: 720, duration: 40 });
		expect(facts.thumbnail?.type).toBe('image/jpeg');
		// At 4 s, scaled down to the thumbnail width, its shape kept.
		expect(canvas.draws).toEqual([{ at: 4, size: [0, 0, THUMBNAIL_WIDTH, 180] }]);
		expect([canvas.width, canvas.height]).toEqual([THUMBNAIL_WIDTH, 180]);
		expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.85);
	});

	it('never takes the still later than 10 s in, nor scales a small video up', async () => {
		const video = new FakeMedia();
		video.duration = 3600;
		video.videoWidth = 160;
		video.videoHeight = 120;
		const canvas = fakeCanvas();
		canvas.watch(video);
		await inspectMedia(video as unknown as SeekableVideo & CanvasImageSource, canvas);
		expect(canvas.draws).toEqual([{ at: 10, size: [0, 0, 160, 120] }]);
	});

	it('takes no still of sound', async () => {
		const video = new FakeMedia();
		video.videoWidth = video.videoHeight = 0;
		const canvas = fakeCanvas();
		canvas.watch(video);
		const facts = await inspectMedia(video as unknown as SeekableVideo & CanvasImageSource, canvas);
		expect(facts).toEqual({ width: 0, height: 0, duration: 40, thumbnail: null });
		expect(canvas.draws).toEqual([]);
	});

	it('goes without a still the browser drew nothing on, rather than store a black one', async () => {
		const video = new FakeMedia();
		const canvas = fakeCanvas(undefined, { blank: true });
		canvas.watch(video);
		const facts = await inspectMedia(video as unknown as SeekableVideo & CanvasImageSource, canvas);
		expect(canvas.draws).toHaveLength(1);
		expect(facts).toMatchObject({ width: 1280, height: 720, thumbnail: null });
		expect(canvas.toBlob).not.toHaveBeenCalled();
	});

	it('goes without a still when the canvas makes none', async () => {
		const video = new FakeMedia();
		const canvas = fakeCanvas(null);
		canvas.watch(video);
		const facts = await inspectMedia(video as unknown as SeekableVideo & CanvasImageSource, canvas);
		expect(facts.thumbnail).toBeNull();
	});

	it('refuses media the browser cannot play', async () => {
		const video = new FakeMedia();
		video.readyState = 0;
		const facts = inspectMedia(video as unknown as SeekableVideo & CanvasImageSource, fakeCanvas());
		video.error = { code: 4, message: '' };
		video.dispatchEvent(new Event('error'));
		await expect(facts).rejects.toThrow("This browser can't play this video's format");
	});
});

describe('inspectFile', () => {
	function opener(video: FakeMedia) {
		const opened = { video: video as unknown as OpenedVideo['video'], close: vi.fn() };
		return { opened, open: vi.fn((_file: Blob) => opened) };
	}

	it('opens the file in a video of its own, and lets go of it once inspected', async () => {
		const video = new FakeMedia();
		const canvas = fakeCanvas();
		canvas.watch(video);
		const { opened, open } = opener(video);
		const file = new File(['a video'], 'clip.webm');
		const facts = await inspectFile(file, { open, canvas });
		expect(open).toHaveBeenCalledWith(file);
		expect(facts).toMatchObject({ width: 1280, height: 720, duration: 40 });
		expect(facts.thumbnail?.type).toBe('image/jpeg');
		expect(opened.close).toHaveBeenCalledOnce();
	});

	it('lets go of a file the browser cannot play, too', async () => {
		const video = new FakeMedia();
		video.readyState = 0;
		const { opened, open } = opener(video);
		const facts = inspectFile(new File(['notes'], 'notes.mp4'), { open, canvas: fakeCanvas() });
		video.error = { code: 4, message: '' };
		video.dispatchEvent(new Event('error'));
		await expect(facts).rejects.toThrow("This browser can't play this video's format");
		expect(opened.close).toHaveBeenCalledOnce();
	});
});
