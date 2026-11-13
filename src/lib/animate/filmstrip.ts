/**
 * The frame timeline: pictures from across the video — all of it, or the
 * stretch the timeline is zoomed in on — side by side under the time range,
 * so a stretch can be picked by what is in it. Each picture stands for the
 * stretch of the video under it and shows that stretch's middle.
 *
 * The pictures are taken by seeking a <video> of their own, never the
 * dialog's, which shows the range's edges, previews and takes the
 * animation's frames meanwhile.
 */
import type { Size, TimeRange } from './clip';
import { mediaMetadata, seek, type SeekableVideo } from './frames';

/** Each picture is a seek: a strip holds at most this many. */
export const MAX_TILES = 32;

/**
 * How many pictures of the video's shape (`aspect`, width / height) fill a
 * strip as tall as they are: enough to leave no gap, the last one cut short.
 */
export function tileCount(strip: Size, aspect: number): number {
	if (!(strip.width > 0 && strip.height > 0 && aspect > 0)) return 0;
	return Math.min(MAX_TILES, Math.ceil(strip.width / (strip.height * aspect)));
}

/**
 * When each of `count` pictures across `shown` (the stretch the timeline shows)
 * is taken: the middle of the stretch it stands for.
 */
export function tileTimes(shown: TimeRange, count: number): number[] {
	const length = shown.end - shown.start;
	return Array.from(
		{ length: count },
		(_, i) => Math.round((shown.start + ((i + 0.5) * length) / count) * 1e6) / 1e6
	);
}

/** A picture's size on its canvas: as tall as the strip in device pixels, in the video's shape. */
export function tileSize(stripHeight: number, aspect: number, pixelRatio: number): Size {
	const height = Math.max(1, Math.round(stripHeight * pixelRatio));
	return { width: Math.max(1, Math.round(height * aspect)), height };
}

/** What this needs of a canvas. */
export interface TileCanvas {
	readonly width: number;
	readonly height: number;
	getContext(type: '2d'): {
		imageSmoothingEnabled: boolean;
		imageSmoothingQuality: ImageSmoothingQuality;
		drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
	} | null;
}

export interface Tile {
	/** Seconds into the video. */
	time: number;
	canvas: TileCanvas;
}

/**
 * Draws the picture at each tile's time on its canvas, left to right, once
 * `video` knows its length; `ondrawn` hears of each. Rejects when `signal`
 * aborts or the video fails, leaving the rest blank.
 */
export async function drawTiles(
	video: SeekableVideo & CanvasImageSource,
	tiles: readonly Tile[],
	ondrawn?: (index: number) => void,
	signal?: AbortSignal
): Promise<void> {
	await mediaMetadata(video, signal);
	for (const [i, { time, canvas }] of tiles.entries()) {
		await seek(video, time, signal);
		const context = canvas.getContext('2d');
		if (context) {
			// A picture shrunk several times over: the default smoothing would alias its edges.
			context.imageSmoothingEnabled = true;
			context.imageSmoothingQuality = 'high';
			context.drawImage(video, 0, 0, canvas.width, canvas.height);
		}
		ondrawn?.(i);
	}
}
