<script lang="ts">
	import { flushSync } from 'svelte';
	import { formatClipTime } from '#lib/animate/clip.ts';
	import { FORMATS } from '#lib/animate/formats.ts';
	import {
		describeAnimation,
		madeFileName,
		viewMade,
		type AnimationGallery,
		type MadeAnimation
	} from '#lib/animate/gallery.svelte.ts';
	import { formatBytes } from '#lib/formats.ts';
	import AnimatedImage from './AnimatedImage.svelte';
	import AnimationViewer from './AnimationViewer.svelte';
	import { saveFile } from './save';

	interface Props {
		/** The animations made in this tab. */
		gallery: AnimationGallery;
		/** How a file reaches the person (the browser's save dialog, or a download). */
		save?: (file: Blob, name: string) => Promise<void>;
	}

	let { gallery, save = saveFile }: Props = $props();
	/** The animation open in the viewer. */
	let viewing = $state<string | null>(null);
	let list = $state<HTMLUListElement>();
	const count = $derived(gallery.items.length);
	/** What the viewer shows of each, in the same order. */
	const viewed = $derived(gallery.items.map(viewMade));

	/** Lets one go, and keeps focus in the list: on the one now in its place, or the one before. */
	function remove(animation: MadeAnimation) {
		const at = gallery.items.indexOf(animation);
		gallery.remove(animation.id);
		flushSync();
		const previews = list?.querySelectorAll<HTMLButtonElement>('.preview') ?? [];
		previews[Math.min(at, previews.length - 1)]?.focus();
	}
</script>

{#if count}
	<section class="animations" aria-labelledby="animations-title">
		<div class="heading">
			<h2 id="animations-title">Animations</h2>
			<p class="hint">
				{count}
				{count === 1 ? 'animation' : 'animations'} · {formatBytes(gallery.bytes)}. Kept only until
				this tab is reloaded or closed: save the ones you want to keep.
			</p>
		</div>
		<ul bind:this={list} aria-label="Animations made in this tab">
			{#each gallery.items as animation (animation.id)}
				{@const name = describeAnimation(animation)}
				{@const label = FORMATS[animation.format].label}
				<li>
					<figure aria-label={name}>
						<button
							type="button"
							class="preview"
							onclick={() => (viewing = animation.id)}
							aria-label="View {name}"
						>
							<AnimatedImage
								blob={animation.blob}
								alt=""
								width={animation.width}
								height={animation.height}
							>
								{#snippet unshowable()}
									<span class="placeholder" data-unshowable>Can't show {label} here</span>
								{/snippet}
							</AnimatedImage>
							<!-- In its place where motion is to be kept down: the viewer still plays it. -->
							<span class="still" aria-hidden="true">{label}</span>
						</button>
						<figcaption>
							<span class="title">{animation.source.title}</span>
							<span>
								{label} · {formatClipTime(animation.range.start)}–{formatClipTime(
									animation.range.end
								)}
							</span>
							<span>
								{animation.width} × {animation.height} px · {formatBytes(animation.blob.size)}
							</span>
						</figcaption>
					</figure>
					<div class="actions">
						<button
							type="button"
							onclick={() => save(animation.blob, madeFileName(animation))}
							aria-label="Save {name}"
						>
							Save
						</button>
						<button type="button" onclick={() => remove(animation)} aria-label="Remove {name}">
							Remove
						</button>
					</div>
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if viewing}
	<AnimationViewer
		items={viewed}
		bind:id={() => viewing!, (id) => (viewing = id)}
		onremove={(id) => gallery.remove(id)}
		{save}
		onclose={() => (viewing = null)}
	/>
{/if}

<style>
	.animations {
		display: grid;
		gap: 0.75rem;
		margin-top: 0.75rem;
		padding: 0.75rem 1rem 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}

	h2 {
		margin: 0;
		font-size: 1.05rem;
	}

	.hint {
		margin: 0.1rem 0 0;
		color: var(--muted);
		font-size: 0.9rem;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 13rem), 1fr));
		gap: 0.75rem;
	}

	/* A card: the animation and what it is, its buttons at the foot. */
	li {
		display: grid;
		grid-template-rows: 1fr auto;
		gap: 0.5rem;
		padding: 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg);
	}

	figure {
		margin: 0;
		display: grid;
		grid-template-rows: auto 1fr;
		gap: 0.5rem;
	}

	/* One shape for every card, a video's; each animation fills it, whole, on a checkerboard. */
	.preview {
		aspect-ratio: 16 / 9;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		overflow: hidden;
		border-radius: 6px;
		background: repeating-conic-gradient(var(--surface-2) 0 25%, var(--surface) 0 50%) 0 0 / 16px
			16px;
	}

	.preview :global(img) {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	.placeholder,
	.still {
		padding: 0.5rem;
		color: var(--muted);
		font-size: 0.85rem;
		text-align: center;
	}

	.still {
		display: none;
		font-size: 1.1rem;
		font-weight: 600;
	}

	/* No looping pictures for those who keep motion down: each still plays when viewed. */
	@media (prefers-reduced-motion: reduce) {
		.preview > :global(:not(.still)) {
			display: none;
		}

		.still {
			display: block;
		}
	}

	figcaption {
		display: grid;
		align-content: start;
		gap: 0.1rem;
		min-width: 0;
		color: var(--muted);
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
	}

	.title {
		color: var(--text);
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.actions {
		display: flex;
		gap: 0.4rem;
	}

	.actions button {
		flex: 1 1 0;
	}
</style>
