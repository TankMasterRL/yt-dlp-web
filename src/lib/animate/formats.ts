/**
 * The animated image formats the editor can write, and what the page needs to
 * know about each. Which of them a browser can make is asked at runtime
 * (support.ts); how each is made lives in the animate worker (encoder.ts).
 */

export type AnimationFormat = 'gif' | 'webp' | 'apng' | 'avif' | 'jxl';

export interface FormatSpec {
	label: string;
	mime: string;
	/** File extension, without the dot. */
	ext: string;
	/** Whether a quality setting applies (lossy compression). */
	lossy: boolean;
	/** Whether its colors come from a palette built from sample frames first. */
	palette: boolean;
	/** One line on what it is good for, shown under the choice. */
	note: string;
}

export const FORMATS: Record<AnimationFormat, FormatSpec> = {
	gif: {
		label: 'GIF',
		mime: 'image/gif',
		ext: 'gif',
		lossy: false,
		palette: true,
		note: '256 colors, plays everywhere.'
	},
	webp: {
		label: 'WebP',
		mime: 'image/webp',
		ext: 'webp',
		lossy: true,
		palette: false,
		note: 'Full color and small, plays in every current browser.'
	},
	apng: {
		label: 'APNG',
		mime: 'image/apng',
		ext: 'png',
		lossy: false,
		palette: false,
		note: 'Lossless full color — large files. Plays in every current browser.'
	},
	avif: {
		label: 'AVIF',
		mime: 'image/avif',
		ext: 'avif',
		lossy: true,
		palette: false,
		note: 'Full color and smallest, encoded as AV1. Plays in every current browser.'
	},
	jxl: {
		label: 'JPEG XL',
		mime: 'image/jxl',
		ext: 'jxl',
		lossy: false,
		palette: false,
		note: 'Lossless full color. Few browsers can show it yet.'
	}
};

export const FORMAT_ORDER: AnimationFormat[] = ['gif', 'webp', 'apng', 'avif', 'jxl'];

/** Lossy formats' quality, 1 (smallest) to 100 (best). */
export const QUALITY_CHOICES = [50, 60, 70, 75, 80, 90, 100] as const;
export const DEFAULT_QUALITY = 75;
