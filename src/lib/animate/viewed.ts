/**
 * What the animation viewer shows of an image, whichever it is: one made in
 * this tab (`viewMade` in gallery.svelte.ts) or a file opened from the device
 * (`viewOpened` in opened.ts). Each says what it is in its own words; the
 * viewer only lays them out.
 */
export interface ViewedImage {
	readonly id: string;
	/** The image's file, shown as it is. */
	readonly blob: Blob;
	readonly width: number;
	readonly height: number;
	/** The heading: the video it was made of, or the file's name. */
	readonly title: string;
	/** Under the heading: what it is. */
	readonly what: string;
	/** The image's text alternative. */
	readonly alt: string;
	/** Its size, frames, length and bytes, as far as they are known. */
	readonly details: string;
	/** The format's name: 'GIF'. */
	readonly label: string;
	/** Said in the image's place when the browser can't show it. */
	readonly unshowable: string;
	/** The name it is saved under; null when there is nothing to save (the file is the person's own). */
	readonly fileName: string | null;
}

/** '1 frame', '24 frames'. */
export function frameCount(frames: number): string {
	return `${frames} ${frames === 1 ? 'frame' : 'frames'}`;
}

/** Seconds as the viewer shows them: '2.0 s'. */
export function seconds(duration: number): string {
	return `${duration.toFixed(1)} s`;
}
