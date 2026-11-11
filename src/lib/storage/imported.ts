/**
 * Library items for media files imported from this device. Pure: the browser
 * reads the file's facts (inspect.ts) and the download worker copies its bytes
 * into OPFS; this only says what the library records about it.
 */
import type { ImportedItem } from './db';

/** What the browser could tell of a media file by opening it. */
export interface MediaFacts {
	/** Seconds; not finite when the file does not say. */
	duration: number;
	/** 0 × 0 for sound only. */
	width: number;
	height: number;
	/** A still from the video, or null (sound only, or none could be taken). */
	thumbnail: Blob | null;
}

/** Extensions for media types whose subtype is not the usual extension. */
const TYPE_EXTENSIONS: Record<string, string> = {
	'video/quicktime': 'mov',
	'video/x-matroska': 'mkv',
	'video/x-msvideo': 'avi',
	'video/ogg': 'ogv',
	'audio/mpeg': 'mp3',
	'audio/mp4': 'm4a',
	'audio/x-m4a': 'm4a',
	'audio/webm': 'weba',
	'audio/x-wav': 'wav'
};

const TOKEN = /^[a-z0-9]{1,10}$/;

/** The file's name without its extension: what the library calls it. */
export function importedTitle(name: string): string {
	const trimmed = name.trim();
	return trimmed.replace(/\.[^.]*$/, '').trim() || trimmed || 'Video';
}

/** A plain extension for the stored file: the name's, else the type's, else `bin`. */
export function importedExt(name: string, type: string): string {
	const fromName = name.match(/\.([^./\\]+)$/)?.[1].toLowerCase();
	if (fromName && TOKEN.test(fromName)) return fromName;
	const mime = type.toLowerCase().split(';')[0].trim();
	const fromType = TYPE_EXTENSIONS[mime] ?? mime.match(/^(?:video|audio)\/(?:x-)?(.+)$/)?.[1];
	return fromType && TOKEN.test(fromType) ? fromType : 'bin';
}

export function importedItem({
	id,
	file,
	media,
	now
}: {
	id: string;
	file: Pick<File, 'name' | 'type' | 'size'>;
	media: MediaFacts;
	now: number;
}): ImportedItem {
	const ext = importedExt(file.name, file.type);
	const picture = media.width > 0 && media.height > 0;
	return {
		id,
		origin: 'import',
		title: importedTitle(file.name),
		originalName: file.name,
		duration: Number.isFinite(media.duration) && media.duration > 0 ? media.duration : undefined,
		ext,
		// Whether it has sound too no browser says alike; 'av' is "picture, sound unknown".
		kind: picture ? 'av' : 'audio',
		resolution: picture ? `${media.height}p` : 'audio only',
		fileName: `${id}.${ext}`,
		bytesTotal: file.size,
		bytesDone: 0,
		status: 'importing',
		createdAt: now,
		...(media.thumbnail ? { thumbnail: media.thumbnail } : {})
	};
}
