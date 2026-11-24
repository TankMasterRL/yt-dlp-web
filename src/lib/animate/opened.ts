/**
 * Animated images opened from the device, to look at in the viewer: read
 * where they are and never copied, stored or sent anywhere. Only what their
 * headers say is taken from them (read.ts); the viewer shows the file itself,
 * for as long as it is open.
 */
import { formatBytes } from '#lib/formats.ts';
import { FORMATS, type AnimationFormat } from './formats';
import { SIGNATURE_BYTES, imageFormat, readImage, type ImageInfo } from './read';
import { frameCount, seconds, type ViewedImage } from './viewed';

/** What the file picker offers: the five formats the app makes, by type and by name. */
export const IMAGE_FILES = [
	'image/gif',
	'image/png',
	'image/apng',
	'image/webp',
	'image/avif',
	'image/jxl',
	'.gif',
	'.png',
	'.apng',
	'.webp',
	'.avif',
	'.jxl'
].join(',');

export interface OpenedImage {
	/** Unique in this page. */
	readonly id: string;
	readonly file: File;
	readonly info: ImageInfo;
}

const NOT_AN_IMAGE = "it isn't a GIF, PNG, WebP, AVIF or JPEG XL image";
/** A format's name before its file is read: a PNG may or may not play. */
const named = (format: AnimationFormat) => (format === 'apng' ? 'PNG' : FORMATS[format].label);

let opened = 0;

/**
 * Reads what `file` says of itself. Its first bytes say whether it is an image
 * at all, before the rest is read: a video picked by mistake is never loaded.
 * Fails, with the reason, for anything else or a header past reading.
 */
export async function openImage(file: File): Promise<OpenedImage> {
	const start = new Uint8Array(await file.slice(0, SIGNATURE_BYTES).arrayBuffer());
	const format = imageFormat(start);
	if (!format) throw new Error(NOT_AN_IMAGE);
	const info = readImage(new Uint8Array(await file.arrayBuffer()));
	if (!info) throw new Error(`it seems to be a ${named(format)}, but its header can't be read`);
	return { id: `opened-${++opened}`, file, info };
}

/** The format's name: a PNG that does not play is no APNG. */
export function imageLabel({ format, animated }: ImageInfo): string {
	return format === 'apng' && !animated ? 'PNG' : FORMATS[format].label;
}

/** What the viewer shows of an opened file: its name, and what its headers say. */
export function viewOpened({ id, file, info }: OpenedImage): ViewedImage {
	const label = imageLabel(info);
	const frames = info.frames !== null ? frameCount(info.frames) : info.animated ? 'animated' : null;
	return {
		id,
		blob: file,
		width: info.width,
		height: info.height,
		title: file.name,
		what: `${label} from this device`,
		alt: `The ${info.animated ? 'animated ' : ''}${label} ${file.name}`,
		details: [
			`${info.width} × ${info.height} px`,
			frames,
			info.duration === null ? null : seconds(info.duration),
			formatBytes(file.size)
		]
			.filter((part) => part !== null)
			.join(' · '),
		label,
		unshowable: `This browser can't show this ${label} image. Open it with a browser or viewer that can.`,
		fileName: null
	};
}
