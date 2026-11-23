<script lang="ts">
	import { formatClipTime } from '#lib/animate/clip.ts';
	import { FORMATS } from '#lib/animate/formats.ts';
	import {
		madeFileName,
		type AnimationGallery,
		type MadeAnimation
	} from '#lib/animate/gallery.svelte.ts';
	import { formatBytes } from '#lib/formats.ts';
	import AnimatedImage from './AnimatedImage.svelte';
	import { saveFile } from './save';

	interface Props {
		/** The animations made in this tab, to step through. */
		gallery: AnimationGallery;
		/** The one on show. */
		id: string;
		/** How a file reaches the person (the browser's save dialog, or a download). */
		save?: (file: Blob, name: string) => Promise<void>;
		onclose: () => void;
	}

	let { gallery, id = $bindable(), save = saveFile, onclose }: Props = $props();
	let dialog: HTMLDialogElement;
	const index = $derived(gallery.items.findIndex((a) => a.id === id));
	const animation = $derived<MadeAnimation | undefined>(gallery.items[index]);

	/** Shows the one `by` places along, round from the last to the first. */
	function step(by: number) {
		const { items } = gallery;
		id = items[(index + by + items.length) % items.length].id;
	}

	function keydown(event: KeyboardEvent) {
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		if (gallery.items.length < 2) return;
		if (event.key === 'ArrowLeft') step(-1);
		else if (event.key === 'ArrowRight') step(1);
		else return;
		event.preventDefault();
	}

	/** Lets the one on show go, and shows the one now in its place; with none left, closes. */
	function remove() {
		const at = index;
		gallery.remove(id);
		const { items } = gallery;
		if (items.length) id = items[Math.min(at, items.length - 1)].id;
		else dialog.close();
	}
</script>

<!-- The dialog is modal: while it is open, every key press is in it. -->
<svelte:window onkeydown={keydown} />

<dialog
	bind:this={dialog}
	{@attach (node) => node.showModal()}
	{onclose}
	aria-labelledby="viewer-title"
	aria-describedby="viewer-what"
>
	{#if animation}
		{@const label = FORMATS[animation.format].label}
		{@const stretch = `${formatClipTime(animation.range.start)} to ${formatClipTime(animation.range.end)}`}
		<header>
			<div>
				<h2 id="viewer-title">{animation.source.title}</h2>
				<p id="viewer-what" class="what">{label} of {stretch} of the video</p>
			</div>
			<button type="button" onclick={() => dialog.close()} aria-label="Close the animation viewer">
				Close
			</button>
		</header>

		<!-- One height for every animation, so stepping through them never moves the buttons. -->
		<div class="stage">
			<AnimatedImage
				blob={animation.blob}
				alt="The animated {label}: {stretch} of {animation.source.title}"
				width={animation.width}
				height={animation.height}
			>
				{#snippet unshowable()}
					<p class="note" data-unshowable>
						This browser can't show {label} images. The file is fine: save it, and open it with a browser
						or viewer that can.
					</p>
				{/snippet}
			</AnimatedImage>
		</div>
		<p class="details">
			{animation.width} × {animation.height} px · {animation.frames} frames · {animation.duration.toFixed(
				1
			)} s · {formatBytes(animation.blob.size)}
		</p>

		<footer>
			{#if gallery.items.length > 1}
				<div class="steps">
					<button type="button" onclick={() => step(-1)} aria-label="Previous animation">
						Previous
					</button>
					<span aria-live="polite">{index + 1} of {gallery.items.length}</span>
					<button type="button" onclick={() => step(1)} aria-label="Next animation">Next</button>
				</div>
			{/if}
			<div class="actions">
				<button type="button" onclick={remove}>Remove</button>
				<button
					type="button"
					class="primary"
					onclick={() => save(animation.blob, madeFileName(animation))}
				>
					Save {label}
				</button>
			</div>
		</footer>
	{/if}
</dialog>

<style>
	dialog {
		width: min(56rem, calc(100vw - 2rem));
		max-width: none;
		max-height: calc(100vh - 2rem);
		max-height: calc(100dvh - 2rem);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		padding: 0;
		overflow: hidden auto;
		overscroll-behavior: contain;
		/* The picture's room: the stage's height, and the most an animation is shown at. */
		--stage: min(60dvh, 36rem);
	}

	dialog::backdrop {
		background: rgb(0 0 0 / 0.6);
	}

	header,
	.details,
	footer {
		padding-inline: 1.25rem;
	}

	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding-block: 1rem 0.75rem;
	}

	h2 {
		margin: 0;
		font-size: 1.05rem;
		overflow-wrap: anywhere;
	}

	.what {
		margin: 0.1rem 0 0;
		color: var(--muted);
		font-size: 0.9rem;
	}

	.stage {
		height: var(--stage);
		display: flex;
		align-items: center;
		justify-content: center;
		padding-inline: 1.25rem;
	}

	/* At its own size, unless that is more than there is room for. */
	.stage :global(img) {
		display: block;
		width: auto;
		height: auto;
		max-width: 100%;
		max-height: var(--stage);
		border-radius: 6px;
		background: repeating-conic-gradient(var(--surface-2) 0 25%, var(--surface) 0 50%) 0 0 / 16px
			16px;
	}

	.note {
		max-width: 30rem;
		margin: 0;
		color: var(--warn);
		text-align: center;
	}

	.details {
		margin: 0;
		padding-top: 0.75rem;
		color: var(--muted);
		font-size: 0.9rem;
		font-variant-numeric: tabular-nums;
	}

	footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		padding-block: 0.75rem;
		/* Clear of a phone's home indicator. */
		padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
	}

	.steps,
	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.steps span {
		min-width: 5em;
		color: var(--muted);
		font-size: 0.9rem;
		font-variant-numeric: tabular-nums;
		text-align: center;
	}

	.actions {
		margin-left: auto;
	}

	/* Phones: the whole screen. */
	@media (max-width: 40rem), (max-height: 32rem) {
		dialog {
			width: 100%;
			height: 100vh;
			height: 100dvh;
			max-height: none;
			margin: 0;
			border: 0;
			border-radius: 0;
			--stage: max(10rem, calc(100dvh - 13rem));
		}

		header,
		.details,
		footer {
			padding-inline: max(1rem, env(safe-area-inset-left)) max(1rem, env(safe-area-inset-right));
		}

		.stage {
			padding-inline: 0;
		}

		.steps,
		.actions {
			flex: 1 1 100%;
		}

		.steps {
			justify-content: space-between;
		}

		.actions button {
			flex: 1 1 0;
		}
	}
</style>
