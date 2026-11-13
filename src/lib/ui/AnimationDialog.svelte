<script module lang="ts">
	import { workerFormats, type FormatSupport } from '$lib/animate/client';

	/** Which formats this browser can make holds while the page is open: asked once, not per video. */
	let formats: Promise<FormatSupport> | undefined;

	function knownFormats(): Promise<FormatSupport> {
		formats ??= workerFormats().catch((e: Error) => {
			// Asked again next time: a worker that failed once may not fail twice.
			formats = undefined;
			throw e;
		});
		return formats;
	}
</script>

<script lang="ts">
	import {
		FPS_CHOICES,
		MAX_FRAMES,
		WIDTH_CHOICES,
		animationFileName,
		evenRates,
		formatClipTime,
		formatFps,
		fullFrame,
		type TimeRange
	} from '$lib/animate/clip';
	import { workerEncoder } from '$lib/animate/client';
	import { AnimationEditor } from '$lib/animate/editor.svelte';
	import { FORMATS, FORMAT_ORDER, QUALITY_CHOICES } from '$lib/animate/formats';
	import {
		learnGrid,
		mediaMetadata,
		openVideo,
		videoFrames,
		videoMetadata
	} from '$lib/animate/frames';
	import { frameRate } from '$lib/animate/grid';
	import { formatBytes } from '$lib/formats';
	import CropBox from './CropBox.svelte';
	import Filmstrip from './Filmstrip.svelte';
	import RangeSlider from './RangeSlider.svelte';
	import { saveFile } from './save';
	import Spinner from './Spinner.svelte';
	import ZoomBar from './ZoomBar.svelte';

	interface Props {
		/** The video: from the library's private storage, or a file opened straight from disk. */
		file: File;
		/** What the saved file is named after; a file from disk has no format. */
		item: { title: string; formatId?: string };
		onclose: () => void;
	}

	let { file, item, onclose }: Props = $props();

	const editor = new AnimationEditor(() => workerEncoder());
	let dialog: HTMLDialogElement;
	let video: HTMLVideoElement;
	let loadError = $state<string | null>(null);
	/** Whether the stage shows the video's picture yet (until then it says the video is opening). */
	let pictured = $state(false);
	/** Whether the video's own frame rate is being learned: the editor works meanwhile. */
	let measuring = $state(false);
	/** Where the video is, shown on the time range. */
	let playhead = $state(0);
	/** The stretch of the video the frame timeline is zoomed in on (null: all of it). */
	let view = $state<TimeRange | null>(null);
	let previewing = $state(false);
	let resultUrl = $state<string | null>(null);
	/** Whether the browser failed to show the result (most cannot show JPEG XL yet). */
	let unshowable = $state(false);
	/** Which formats this browser can make; null until its worker has said. */
	let support = $state<FormatSupport | null>(null);
	let frameRequest = 0;
	const spec = $derived(FORMATS[editor.format]);
	/** The rates that step evenly through the video's pictures, as a phrase: '5, 10, 15 or 30'. */
	const smoothRates = $derived.by(() => {
		const rates = editor.sourceFps ? evenRates(editor.sourceFps) : [];
		return rates.length > 1
			? `${rates.slice(0, -1).join(', ')} or ${rates.at(-1)}`
			: rates.join('');
	});

	/** Whether the worker has said which formats it can make (for tests, as data-formats). */
	let asked = $state<'asking' | 'known' | 'unknown'>('asking');

	knownFormats().then(
		(formats) => {
			support = formats;
			asked = 'known';
			if (!formats[editor.format]) editor.format = 'gif';
		},
		// Without an answer every format stays on offer; making one says what is wrong.
		() => (asked = 'unknown')
	);

	// The video plays from a blob: URL over the file (CSP media-src blob:). The editor opens
	// as soon as the video's size and length are known; its frame rate is learned alongside.
	$effect(() => {
		const url = URL.createObjectURL(file);
		const opening = new AbortController();
		video.src = url;
		dialog.showModal();
		videoMetadata(video)
			.then((media) => {
				if (opening.signal.aborted) return;
				editor.setMedia(media);
				view = null;
				measuring = true;
				void sourceFps(media.duration, opening.signal).then((fps) => {
					if (opening.signal.aborted) return;
					editor.learnSourceFps(fps);
					measuring = false;
				});
			})
			.catch((e: Error) => {
				if (!opening.signal.aborted) loadError = e.message;
			});
		return () => {
			opening.abort();
			stopPreview();
			editor.cancel();
			URL.revokeObjectURL(url);
		};
	});

	/** How long the dialog waits to learn the video's frame rate before going on without it. */
	const RATE_TIMEOUT_MS = 4000;

	/**
	 * The video's own frame rate, from moments of its first seconds playing (enough to
	 * tell 29.97 fps from 30); null when the browser can't tell, or not soon. Played in
	 * a <video> of its own, never the dialog's: meanwhile that one shows the range's
	 * edges as they are scrubbed, previews, and takes the animation's frames.
	 */
	async function sourceFps(duration: number, signal: AbortSignal): Promise<number | null> {
		const opened = openVideo(file);
		const looking = new AbortController();
		const stop = () => looking.abort(signal.reason);
		signal.addEventListener('abort', stop);
		const timer = setTimeout(
			() => looking.abort(new DOMException('', 'TimeoutError')),
			RATE_TIMEOUT_MS
		);
		try {
			await mediaMetadata(opened.video, looking.signal);
			const range = { start: 0, end: Math.min(duration, 4) };
			const grid = await learnGrid(opened.video, range, looking.signal);
			return grid && frameRate(grid);
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
			signal.removeEventListener('abort', stop);
			opened.close();
		}
	}

	// The finished file, shown from a blob: URL (CSP img-src blob:).
	$effect(() => {
		const result = editor.result;
		if (!result) return;
		const url = URL.createObjectURL(result.blob);
		resultUrl = url;
		unshowable = false;
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
		if (result) await saveFile(result.blob, animationFileName(item, result.range, result.format));
	}
</script>

<dialog bind:this={dialog} {onclose} aria-labelledby="animate-title">
	<header>
		<div>
			<h2 id="animate-title">Make an animated image</h2>
			<p class="source">{item.title}</p>
		</div>
		<button type="button" onclick={() => dialog.close()} aria-label="Close the animation maker"
			>Close</button
		>
	</header>

	<div class="body">
		{#if loadError}
			<p class="error" role="alert">{loadError}</p>
		{/if}
		<div class="view" class:hidden={loadError}>
			<div
				class="stage"
				style:--aspect={editor.media ? editor.media.width / editor.media.height : 16 / 9}
			>
				<!-- svelte-ignore a11y_media_has_caption -->
				<video
					bind:this={video}
					muted
					playsinline
					preload="auto"
					onloadeddata={() => (pictured = true)}
					onseeked={() => (playhead = video.currentTime)}
					ontimeupdate={() => (playhead = video.currentTime)}
				></video>
				{#if !pictured}
					<p class="opening" role="status"><Spinner />Opening the video…</p>
				{/if}
				{#if editor.media}
					<CropBox bind:crop={editor.crop} bounds={editor.media} disabled={editor.rendering} />
				{/if}
			</div>
			{#if editor.media}
				<div class="timeline">
					<RangeSlider
						bind:range={editor.range}
						bind:view
						duration={editor.media.duration}
						{playhead}
						fps={editor.fps}
						disabled={editor.rendering}
						onscrub={show}
					>
						<Filmstrip {file} media={editor.media} {view} />
					</RangeSlider>
					<ZoomBar bind:view duration={editor.media.duration} range={editor.range} />
				</div>
				<p class="readout" aria-live="polite">
					<span>Start <strong>{formatClipTime(editor.range.start)}</strong></span>
					<span>End <strong>{formatClipTime(editor.range.end)}</strong></span>
					<span>Length <strong>{(editor.range.end - editor.range.start).toFixed(1)} s</strong></span
					>
					<span>Crop <strong>{editor.crop.width} × {editor.crop.height}</strong></span>
					{#if editor.sourceFps}
						<span>Video <strong>{formatFps(editor.sourceFps)} fps</strong></span>
					{:else if measuring}
						<span data-measuring><Spinner />Measuring the video's frame rate…</span>
					{/if}
				</p>
				<div class="view-actions">
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
			{/if}
		</div>

		{#if editor.media}
			<section class="settings" aria-label="Animation settings">
				<div class="options">
					<label>
						Format
						<select bind:value={editor.format} disabled={editor.rendering} data-formats={asked}>
							{#each FORMAT_ORDER as format (format)}
								<option value={format} disabled={support?.[format] === false}
									>{FORMATS[format].label}{support?.[format] === false
										? ' (not in this browser)'
										: ''}</option
								>
							{/each}
						</select>
					</label>
					{#if spec.lossy}
						<label>
							Quality
							<select bind:value={editor.quality} disabled={editor.rendering}>
								{#each QUALITY_CHOICES as quality (quality)}<option value={quality}
										>{quality}</option
									>{/each}
							</select>
						</label>
					{/if}
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
				</div>
				<p class="format-note">{spec.label}: {spec.note}</p>
				{#if !editor.even && editor.sourceFps}
					<p class="format-note" data-uneven>
						{editor.fps} fps doesn't step evenly through this video's {formatFps(editor.sourceFps)} fps,
						so motion judders.{smoothRates ? ` Smooth: ${smoothRates} fps.` : ''}
					</p>
				{/if}
			</section>
		{/if}

		{#if editor.result && resultUrl}
			{@const result = editor.result}
			{@const label = FORMATS[result.format].label}
			<!-- It appears below the settings: bring it into view. -->
			<section
				class="result"
				aria-labelledby="result-title"
				{@attach (node) => node.scrollIntoView({ block: 'nearest' })}
			>
				<h3 id="result-title">Your {label}</h3>
				{#if unshowable}
					<p class="note" data-unshowable>
						This browser can't show {label} images. The file is fine: save it, and open it with a browser
						or viewer that can.
					</p>
				{:else}
					<img
						src={resultUrl}
						alt="The animated {label}: {formatClipTime(result.range.start)} to {formatClipTime(
							result.range.end
						)} of the video"
						width={result.width}
						height={result.height}
						decoding="async"
						onerror={() => (unshowable = true)}
					/>
				{/if}
				<p>
					{result.width} × {result.height} px · {result.frames} frames · {result.duration.toFixed(
						1
					)}
					s · {formatBytes(result.blob.size)}
				</p>
				<button type="button" class="primary" onclick={save}>Save {label}</button>
			</section>
		{/if}
	</div>

	{#if editor.media}
		<!-- Always in view, however far the settings scroll. -->
		<footer>
			<div class="make">
				<p id="animate-summary" class="summary">
					{spec.label}: {editor.size.width} × {editor.size.height} px · {editor.frameCount} frames
				</p>
				{#if editor.rendering && editor.progress}
					<progress max={editor.progress.total} value={editor.progress.done}></progress>
					<span role="status">
						{editor.progress.done < editor.progress.total
							? `Taking frame ${editor.progress.done + 1} of ${editor.progress.total}…`
							: `Finishing the ${spec.label}…`}
					</span>
					<button type="button" onclick={() => editor.cancel()}>Cancel</button>
				{:else}
					<button
						type="button"
						class="primary"
						onclick={create}
						disabled={editor.tooLong}
						aria-describedby="animate-summary">Create {spec.label}</button
					>
				{/if}
			</div>
			{#if editor.tooLong}
				<p class="note">
					That's more than {MAX_FRAMES} frames: shorten the range or lower the frame rate.
				</p>
			{/if}
			{#if editor.error}<p class="error" role="alert">{editor.error}</p>{/if}
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
		overflow: hidden;
		/* The stage's height: room for the time range and settings below it. */
		--stage-height: 42dvh;
	}

	/* Header and footer stay put; what is between them scrolls. */
	dialog[open] {
		display: flex;
		flex-direction: column;
	}

	dialog::backdrop {
		background: rgb(0 0 0 / 0.6);
	}

	header,
	.body,
	footer {
		padding-inline: 1.25rem;
	}

	header {
		flex: none;
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding-block: 1rem 0.75rem;
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

	.body {
		flex: 1 1 auto;
		min-height: 0;
		/* Crop handles reach past the stage's edges: never far enough to scroll sideways for. */
		overflow: hidden auto;
		overscroll-behavior: contain;
		/* Room above for the top crop handles, which stand half out of the stage. */
		padding-block: 0.75rem 1rem;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-content: start;
		gap: 1.25rem;
	}

	.view {
		display: grid;
		gap: 0.75rem;
		min-width: 0;
	}

	.view.hidden {
		display: none;
	}

	/* Exactly the video's shape, so the crop's percentages are the picture's. */
	.stage {
		position: relative;
		width: min(100%, calc(var(--stage-height) * var(--aspect)));
		aspect-ratio: var(--aspect);
		margin: 0 auto;
		background: #000;
	}

	video {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
	}

	/* Over the black stage until the first picture is in: the video is on its way. */
	.opening {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		margin: 0;
		color: #fff;
		font-size: 0.9rem;
		pointer-events: none;
	}

	/* The time range over its frame timeline, and the zoom under it. */
	.timeline {
		display: grid;
		gap: 0.5rem;
		min-width: 0;
	}

	.settings {
		display: grid;
		gap: 0.75rem;
		min-width: 0;
	}

	.readout,
	.view-actions,
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

	.view-actions {
		gap: 0.5rem;
	}

	/* Label over field, as many to a row as fit. */
	.options {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
		gap: 0.75rem;
	}

	.options label {
		display: grid;
		gap: 0.3rem;
		font-size: 0.9rem;
		color: var(--muted);
	}

	select {
		width: 100%;
		min-height: 2.5rem;
		padding: 0.4rem 0.6rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--text);
	}

	.format-note {
		margin: 0;
		color: var(--muted);
		font-size: 0.85rem;
	}

	footer {
		flex: none;
		display: grid;
		gap: 0.5rem;
		padding-block: 0.75rem;
		/* Clear of a phone's home indicator. */
		padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
		border-top: 1px solid var(--border);
		background: var(--surface);
	}

	footer p {
		margin: 0;
	}

	.summary {
		flex: 1 1 12rem;
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
		margin: 0;
		color: var(--danger);
	}

	.result {
		padding-top: 1rem;
		border-top: 1px solid var(--border);
		display: grid;
		justify-items: start;
		gap: 0.5rem;
		min-width: 0;
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

	/* Phones: the whole screen, the picture and the Create button always in reach. */
	@media (max-width: 40rem), (max-height: 32rem) {
		dialog {
			width: 100%;
			height: 100vh;
			height: 100dvh;
			max-height: none;
			margin: 0;
			border: 0;
			border-radius: 0;
			--stage-height: 40dvh;
		}

		header,
		.body,
		footer {
			padding-inline: max(1rem, env(safe-area-inset-left)) max(1rem, env(safe-area-inset-right));
		}

		header {
			padding-block: 0.75rem 0.5rem;
		}

		.body {
			gap: 1rem;
		}

		.view-actions button {
			flex: 1 1 0;
		}

		.make button {
			flex: 1 1 auto;
		}

		progress {
			flex: 1 1 6rem;
		}
	}

	/*
	 * Phones on their side: the picture beside the settings, with the time range
	 * under it in view — the header a single line, the footer a single row.
	 */
	@media (max-height: 32rem) and (min-aspect-ratio: 4 / 3) {
		dialog {
			--stage-height: calc(100dvh - 15.5rem);
		}

		header {
			align-items: center;
			padding-block: 0.4rem;
		}

		header > div {
			display: flex;
			align-items: baseline;
			gap: 0.75rem;
			min-width: 0;
		}

		h2 {
			flex: none;
		}

		.source {
			margin: 0;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		footer {
			padding-block: 0.4rem;
			padding-bottom: max(0.4rem, env(safe-area-inset-bottom));
		}

		.make button {
			flex: none;
		}

		.body {
			grid-template-columns: minmax(0, 1.4fr) minmax(14rem, 1fr);
			align-items: start;
		}

		.result {
			grid-column: 1 / -1;
		}

		.options {
			grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr));
		}
	}
</style>
