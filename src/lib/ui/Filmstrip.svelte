<script lang="ts">
	import type { Size } from '$lib/animate/clip';
	import { drawTiles, tileCount, tileSize, tileTimes } from '$lib/animate/filmstrip';
	import { openVideo, type OpenedVideo, type VideoMetadata } from '$lib/animate/frames';
	import { observeSize } from './size';

	interface Props {
		/** The video. */
		file: Blob;
		/** Its size and length. */
		media: VideoMetadata;
		/** Opens the file in a <video> of the strip's own (tests pass a fake). */
		open?: (file: Blob) => OpenedVideo;
	}

	let { file, media, open = openVideo }: Props = $props();

	let element: HTMLDivElement;
	/** CSS pixels; nothing is taken until it is laid out. */
	let strip = $state<Size>({ width: 0, height: 0 });
	let video = $state.raw<OpenedVideo['video'] | null>(null);
	/** Pictures drawn so far (for tests, as data-taken). */
	let taken = $state(0);
	const aspect = $derived(media.width / media.height);
	// Numbers first, so a resize that changes neither takes nothing again.
	const count = $derived(tileCount(strip, aspect));
	const height = $derived(strip.height);
	const times = $derived(tileTimes(media.duration, count));
	const size = $derived(tileSize(height, aspect, devicePixelRatio));

	// Never the dialog's own video, which meanwhile shows the range's edges, previews and
	// takes the animation's frames.
	$effect(() => {
		const opened = open(file);
		video = opened.video;
		return () => {
			video = null;
			opened.close();
		};
	});

	// Each picture on its canvas, left to right; again whenever the strip holds another number
	// of them, or grows taller.
	$effect(() => {
		if (!video || !times.length) return;
		const canvases = [...element.querySelectorAll('canvas')];
		const tiles = times.map((time, i) => {
			// Sized here, not in the markup: resizing a canvas clears it, and then it is drawn again.
			canvases[i].width = size.width;
			canvases[i].height = size.height;
			return { time, canvas: canvases[i] };
		});
		const taking = new AbortController();
		taken = 0;
		// A strip is a nicety: a video that fails leaves the rest of it blank.
		drawTiles(video, tiles, () => taken++, taking.signal).catch(() => {});
		return () => taking.abort(new DOMException('', 'AbortError'));
	});
</script>

<div
	class="filmstrip"
	bind:this={element}
	data-taken={taken}
	{@attach observeSize((box) => (strip = box))}
>
	{#each times as time (time)}
		<canvas data-time={time}></canvas>
	{/each}
</div>

<style>
	.filmstrip {
		position: absolute;
		inset: 0;
		display: flex;
	}

	/* Side by side across the whole strip; a picture cut short shows its middle. */
	canvas {
		flex: 1 1 0;
		min-width: 0;
		height: 100%;
		display: block;
		object-fit: cover;
	}
</style>
