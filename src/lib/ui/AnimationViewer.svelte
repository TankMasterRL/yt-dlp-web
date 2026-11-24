<script lang="ts">
	import type { ViewedImage } from '#lib/animate/viewed.ts';
	import AnimatedImage from './AnimatedImage.svelte';
	import { saveFile } from './save';

	interface Props {
		/** What to step through, in order: the animations made in this tab, or files opened from the device. */
		items: readonly ViewedImage[];
		/** The one on show. */
		id: string;
		/** Lets one go (an animation made here); without it, there is nothing to remove. */
		onremove?: (id: string) => void;
		/** How a file reaches the person (the browser's save dialog, or a download). */
		save?: (file: Blob, name: string) => Promise<void>;
		onclose: () => void;
	}

	let { items, id = $bindable(), onremove, save = saveFile, onclose }: Props = $props();
	let dialog: HTMLDialogElement;
	const index = $derived(items.findIndex((a) => a.id === id));
	const image = $derived<ViewedImage | undefined>(items[index]);

	/** Shows the one `by` places along, round from the last to the first. */
	function step(by: number) {
		id = items[(index + by + items.length) % items.length].id;
	}

	function keydown(event: KeyboardEvent) {
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		if (items.length < 2) return;
		if (event.key === 'ArrowLeft') step(-1);
		else if (event.key === 'ArrowRight') step(1);
		else return;
		event.preventDefault();
	}

	/** Lets the one on show go, and shows the one now in its place; with none left, closes. */
	function remove() {
		if (!onremove) return;
		const at = index;
		const rest = items.filter((a) => a.id !== id);
		onremove(id);
		if (rest.length) id = rest[Math.min(at, rest.length - 1)].id;
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
	{#if image}
		{@const fileName = image.fileName}
		<header>
			<div>
				<h2 id="viewer-title">{image.title}</h2>
				<p id="viewer-what" class="what">{image.what}</p>
			</div>
			<button type="button" onclick={() => dialog.close()} aria-label="Close the animation viewer">
				Close
			</button>
		</header>

		<!-- One height for every animation, so stepping through them never moves the buttons. -->
		<div class="stage">
			<AnimatedImage blob={image.blob} alt={image.alt} width={image.width} height={image.height}>
				{#snippet unshowable()}
					<p class="note" data-unshowable>{image.unshowable}</p>
				{/snippet}
			</AnimatedImage>
		</div>
		<p class="details">{image.details}</p>

		<footer>
			{#if items.length > 1}
				<div class="steps">
					<button type="button" onclick={() => step(-1)} aria-label="Previous animation">
						Previous
					</button>
					<span aria-live="polite">{index + 1} of {items.length}</span>
					<button type="button" onclick={() => step(1)} aria-label="Next animation">Next</button>
				</div>
			{/if}
			{#if onremove || fileName}
				<div class="actions">
					{#if onremove}
						<button type="button" onclick={remove}>Remove</button>
					{/if}
					{#if fileName}
						<button type="button" class="primary" onclick={() => save(image.blob, fileName)}>
							Save {image.label}
						</button>
					{/if}
				</div>
			{/if}
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
