<script lang="ts">
	import type { FormatKind } from '$lib/formats';

	interface Props {
		file: File;
		title: string;
		kind: FormatKind;
		onclose: () => void;
	}

	let { file, title, kind, onclose }: Props = $props();
	let dialog: HTMLDialogElement;
	let url = $state<string | null>(null);

	// The media plays from a blob: URL over the OPFS file (CSP media-src blob:).
	$effect(() => {
		const objectUrl = URL.createObjectURL(file);
		url = objectUrl;
		dialog.showModal();
		return () => URL.revokeObjectURL(objectUrl);
	});
</script>

<dialog bind:this={dialog} {onclose} aria-labelledby="player-title">
	<header>
		<h2 id="player-title">{title}</h2>
		<button type="button" onclick={() => dialog.close()} aria-label="Close player">Close</button>
	</header>
	{#if url}
		{#if kind === 'audio'}
			<audio controls src={url}></audio>
		{:else}
			<!-- svelte-ignore a11y_media_has_caption -->
			<video controls src={url}></video>
		{/if}
	{/if}
</dialog>

<style>
	dialog {
		width: min(56rem, calc(100vw - 2rem));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		padding: 1rem;
	}

	dialog::backdrop {
		background: rgb(0 0 0 / 0.6);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 0.75rem;
	}

	h2 {
		margin: 0;
		font-size: 1.05rem;
	}

	video,
	audio {
		width: 100%;
		display: block;
		border-radius: 8px;
		background: #000;
	}
</style>
