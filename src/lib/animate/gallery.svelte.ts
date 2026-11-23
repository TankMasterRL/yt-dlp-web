/**
 * The animated images made in this page, to look at again: held in memory as
 * the page holds them, never stored. A reload or a closed tab lets every one
 * go; saving one is how to keep it. One per page (`getGallery`), like the
 * library: moving between the app's pages keeps them.
 */
import { animationFileName, formatClipTime } from './clip';
import type { Animation } from './editor.svelte';
import { FORMATS } from './formats';

/** The video an animation was made of: what its file is named after. */
export interface AnimationSource {
	title: string;
	formatId?: string;
}

export interface MadeAnimation extends Animation {
	/** Unique in this page, and never given again. */
	readonly id: string;
	readonly source: AnimationSource;
	/** When it was made (ms since the epoch). */
	readonly madeAt: number;
}

export class AnimationGallery {
	/** Replaced, never changed in place: the Blobs and their details need no deep proxies. */
	#items = $state.raw<MadeAnimation[]>([]);
	/** What they hold together, in bytes. */
	readonly bytes = $derived(this.#items.reduce((sum, a) => sum + a.blob.size, 0));
	#made = 0;
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** Newest first. */
	get items(): readonly MadeAnimation[] {
		return this.#items;
	}

	/** Keeps an animation made of `source`; what is kept is a copy of both. */
	add(animation: Animation, { title, formatId }: AnimationSource): MadeAnimation {
		const made: MadeAnimation = {
			...animation,
			range: { ...animation.range },
			source: formatId === undefined ? { title } : { title, formatId },
			id: `animation-${++this.#made}`,
			madeAt: this.#now()
		};
		this.#items = [made, ...this.#items];
		return made;
	}

	get(id: string): MadeAnimation | undefined {
		return this.#items.find((a) => a.id === id);
	}

	/** Lets one go: once nothing shows it any more, the browser can free its bytes. */
	remove(id: string): void {
		this.#items = this.#items.filter((a) => a.id !== id);
	}
}

let gallery: AnimationGallery | undefined;

/** The page's one gallery. */
export function getGallery(): AnimationGallery {
	return (gallery ??= new AnimationGallery());
}

/** What a kept animation is saved as: the name the animation maker gives it. */
export function madeFileName(animation: MadeAnimation): string {
	return animationFileName(animation.source, animation.range, animation.format);
}

/** What a kept animation is called on the page: 'GIF of <video>, 0:00.5 to 0:01.5'. */
export function describeAnimation({ format, source, range }: MadeAnimation): string {
	const stretch = `${formatClipTime(range.start)} to ${formatClipTime(range.end)}`;
	return `${FORMATS[format].label} of ${source.title}, ${stretch}`;
}
