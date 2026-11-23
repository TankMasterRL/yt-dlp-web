<script lang="ts">
	import type { Snippet } from 'svelte';
	import { objectUrl } from './object-url';

	interface Props {
		/** The animated image's file. */
		blob: Blob;
		alt: string;
		width: number;
		height: number;
		/** Shown instead when the browser can't show it (most can't show JPEG XL yet). */
		unshowable: Snippet;
	}

	let { blob, alt, width, height, unshowable }: Props = $props();
	/** The file the browser failed to show: another one is tried afresh. */
	let failed = $state.raw<Blob | null>(null);
</script>

{#if failed === blob}
	{@render unshowable()}
{:else}
	<img
		{@attach objectUrl(blob)}
		{alt}
		{width}
		{height}
		decoding="async"
		onerror={() => (failed = blob)}
	/>
{/if}
