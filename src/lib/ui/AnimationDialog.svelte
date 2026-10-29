<script lang="ts">
	import {
		FPS_CHOICES,
		MAX_FRAMES,
		WIDTH_CHOICES,
		animationFileName,
		formatClipTime,
		fullFrame
	} from '$lib/animate/clip';
	import { workerEncoder } from '$lib/animate/client';
	import { AnimationEditor } from '$lib/animate/editor.svelte';
	import { videoFrames, videoMetadata } from '$lib/animate/frames';
	import { formatBytes } from '$lib/formats';
	import type { LibraryItem } from '$lib/storage/db';
	import CropBox from './CropBox.svelte';
	import RangeSlider from './RangeSlider.svelte';
	import { saveFile } from './save';

	interface Props {
		/** The video, from the library's private storage. */
		file: File;
		item: Pick<LibraryItem, 'title' | 'formatId'>;
		onclose: () => void;
	}

	let { file, item, onclose }: Props = $props();

	const editor = new AnimationEditor(() => workerEncoder());
	let dialog: HTMLDialogElement;
	let video: HTMLVideoElement;
	let loadError = $state<string | null>(null);
	/** Where the video is, shown on the time range. */
	let playhead = $state(0);
	let previewing = $state(false);
	let resultUrl = $state<string | null>(null);
	let frameRequest = 0;

	// The video plays from a blob: URL over the OPFS file (CSP media-src blob:).
	$effect(() => {
		const url = URL.createObjectURL(file);
		video.src = url;
		dialog.showModal();
		videoMetadata(video).then(
			(media) => editor.setMedia(media),
			(e: Error) => (loadError = e.message)
		);
		return () => {
			stopPreview();
			editor.cancel();
			URL.revokeObjectURL(url);
		};
	});

	// The finished GIF, shown from a blob: URL (CSP img-src blob:).
	$effect(() => {
		const result = editor.result;
		if (!result) return;
		const url = URL.createObjectURL(result.blob);
		resultUrl = url;
		return () => {
			URL.revokeObjectURL(url);
			resultUrl = null;
		};
	});

	/** Show the frame an edge of the range lands on: the first one, or the last one taken. */
	function show(edge: 'start' | 'end', time: number) {
		stopPreview();
		video.currentTime = edge === 'end' ? Math.max(editor.range.start, time - 1 / editor.fps) : time;
	}

	function startPreview() {
		previewing = true;
		video.currentTime = editor.range.start;
		video.play().catch(() => stopPreview());
		// Loop the range: check every frame, not every timeupdate (four a second).
		const loop = () => {
			if (!previewing) return;
			if (video.currentTime >= editor.range.end || video.ended) {
				video.currentTime = editor.range.start;
				if (video.paused) video.play().catch(() => stopPreview());
			}
			playhead = video.currentTime;
			frameRequest = requestAnimationFrame(loop);
		};
		frameRequest = requestAnimationFrame(loop);
	}

	function stopPreview() {
		if (!previewing) return;
		previewing = false;
		cancelAnimationFrame(frameRequest);
		video.pause();
	}

	async function create() {
		stopPreview();
		await editor.render(videoFrames(video));
	}

	async function save() {
		const result = editor.result;
		if (result) await saveFile(result.blob, animationFileName(item, result.range));
	}
</script>

<dialog bind:this={dialog} {onclose} aria-labelledby="animate-title">
	<header>
		<div>
			<h2 id="animate-title">Make an animated GIF</h2>
			<p class="source">{item.title}</p>
		</div>
		<button type="button" onclick={() => dialog.close()} aria-label="Close the GIF maker"
			>Close</button
		>
	</header>

	{#if loadError}
		<p class="error" role="alert">{loadError}</p>
	{/if}
	<div
		class="stage"
		class:hidden={loadError}
		style:--aspect={editor.media ? editor.media.width / editor.media.height : 16 / 9}
	>
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			bind:this={video}
			muted
			playsinline
			preload="auto"
			onseeked={() => (playhead = video.currentTime)}
			ontimeupdate={() => (playhead = video.currentTime)}
		></video>
		{#if editor.media}
			<CropBox bind:crop={editor.crop} bounds={editor.media} disabled={editor.rendering} />
		{/if}
	</div>

	{#if editor.media}
		<section class="settings" aria-label="Animation settings">
			<RangeSlider
				bind:range={editor.range}
				duration={editor.media.duration}
				{playhead}
				disabled={editor.rendering}
				onscrub={show}
			/>
			<p class="readout" aria-live="polite">
				<span>Start <strong>{formatClipTime(editor.range.start)}</strong></span>
				<span>End <strong>{formatClipTime(editor.range.end)}</strong></span>
				<span>Length <strong>{(editor.range.end - editor.range.start).toFixed(1)} s</strong></span>
				<span>Crop <strong>{editor.crop.width} × {editor.crop.height}</strong></span>
			</p>
			<div class="options">
				<label>
					Frame rate
					<select bind:value={editor.fps} disabled={editor.rendering}>
						{#each FPS_CHOICES as fps (fps)}<option value={fps}>{fps} fps</option>{/each}
					</select>
				</label>
				<label>
					Width
					<select bind:value={editor.width} disabled={editor.rendering}>
						{#each WIDTH_CHOICES as width (width)}<option value={width}>{width} px</option>{/each}
					</select>
				</label>
				<button
					type="button"
					onclick={() => (previewing ? stopPreview() : startPreview())}
					disabled={editor.rendering}>{previewing ? 'Stop preview' : 'Preview'}</button
				>
				<button
					type="button"
					onclick={() => (editor.crop = fullFrame(editor.media!))}
					disabled={editor.rendering}>Reset crop</button
				>
			</div>
			<div class="make">
				<p id="animate-summary" class="summary">
					GIF: {editor.size.width} × {editor.size.height} px · {editor.frameCount} frames
				</p>
				{#if editor.rendering && editor.progress}
					<progress max={editor.progress.total} value={editor.progress.done}></progress>
					<span role="status">
						{editor.progress.done < editor.progress.total
							? `Taking frame ${editor.progress.done + 1} of ${editor.progress.total}…`
							: 'Finishing the GIF…'}
					</span>
					<button type="button" onclick={() => editor.cancel()}>Cancel</button>
				{:else}
					<button
						type="button"
						class="primary"
						onclick={create}
						disabled={editor.tooLong}
						aria-describedby="animate-summary">Create GIF</button
					>
				{/if}
			</div>
			{#if editor.tooLong}
				<p class="note">
					That's more than {MAX_FRAMES} frames: shorten the range or lower the frame rate.
				</p>
			{/if}
			{#if editor.error}<p class="error" role="alert">{editor.error}</p>{/if}
		</section>
	{/if}

	{#if editor.result && resultUrl}
		{@const result = editor.result}
		<!-- It appears below the settings: bring it into view. -->
		<section
			class="result"
			aria-labelledby="result-title"
			{@attach (node) => node.scrollIntoView({ block: 'nearest' })}
		>
			<h3 id="result-title">Your GIF</h3>
			<img
				src={resultUrl}
				alt="The animated GIF: {formatClipTime(result.range.start)} to {formatClipTime(
					result.range.end
				)} of the video"
				width={result.width}
				height={result.height}
			/>
			<p>
				{result.width} × {result.height} px · {result.frames} frames · {result.duration.toFixed(1)} s
				· {formatBytes(result.blob.size)}
			</p>
			<button type="button" class="primary" onclick={save}>Save GIF</button>
		</section>
	{/if}
</dialog>

<style>
	dialog {
		width: min(56rem, calc(100vw - 2rem));
		max-height: calc(100vh - 2rem);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		padding: 1rem 1.25rem 1.25rem;
	}

	dialog::backdrop {
		background: rgb(0 0 0 / 0.6);
	}

	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 0.75rem;
	}

	h2 {
		margin: 0;
		font-size: 1.05rem;
	}

	.source {
		margin: 0.1rem 0 0;
		color: var(--muted);
		font-size: 0.9rem;
		overflow-wrap: anywhere;
	}

	/* Exactly the video's shape, so the crop's percentages are the picture's. */
	.stage {
		position: relative;
		width: min(100%, calc(52vh * var(--aspect)));
		aspect-ratio: var(--aspect);
		margin: 0 auto;
		background: #000;
	}

	.stage.hidden {
		display: none;
	}

	video {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
	}

	.settings {
		margin-top: 1.25rem;
		display: grid;
		gap: 0.75rem;
	}

	.readout,
	.options,
	.make {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		margin: 0;
	}

	.readout {
		color: var(--muted);
		font-size: 0.9rem;
	}

	.readout strong {
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}

	.options label {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	select {
		padding: 0.4rem 0.6rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--surface);
	}

	.summary {
		margin: 0;
		flex: 1 1 auto;
		font-variant-numeric: tabular-nums;
	}

	progress {
		width: 10rem;
	}

	.note {
		margin: 0;
		color: var(--warn);
	}

	.error {
		color: var(--danger);
	}

	.result {
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
		display: grid;
		justify-items: start;
		gap: 0.5rem;
	}

	.result h3 {
		margin: 0;
		font-size: 1rem;
	}

	.result img {
		max-width: 100%;
		height: auto;
		border-radius: 6px;
		background: repeating-conic-gradient(var(--surface-2) 0 25%, var(--surface) 0 50%) 0 0 / 16px
			16px;
	}

	.result p {
		margin: 0;
		color: var(--muted);
		font-size: 0.9rem;
	}
</style>
