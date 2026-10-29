<script lang="ts">
	import { asset, resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { spawnEngine } from '$lib/engine/client';
	import type { BootStage, FormatInfo } from '$lib/engine/runtime';
	import { ExtractSession } from '$lib/engine/session.svelte';
	import { WHEELS } from '$lib/engine/wheels';
	import { appEndpoints } from '$lib/endpoints';
	import {
		bestMergePair,
		codecName,
		formatBytes,
		formatDuration,
		primaryVideo,
		resolutionLabel,
		sizeOf
	} from '$lib/formats';
	import { getLibrary, opfsAvailable } from '$lib/storage/instance';
	import { progressLabel, statusLabel } from '$lib/storage/present';
	import FormatTable from '$lib/ui/FormatTable.svelte';

	// Resolved here, in browser-only code: workers get absolute URLs in `load`.
	const endpoints = appEndpoints();
	const session = new ExtractSession(spawnEngine, {
		assetsBase: endpoints.assetsBase,
		relayEndpoint: endpoints.relay,
		solveEndpoint: endpoints.solve
	});
	const library = getLibrary(endpoints);
	/** Whether this deployment ships an FFmpeg core; null until asked. */
	let canMerge = $state<boolean | null>(null);
	/** Which core the build ships (scripts/sync-assets.ts), under which license. */
	const ffmpeg =
		import.meta.env.YT_DLP_WEB_FFMPEG === 'remux'
			? { name: 'FFmpeg', license: 'LGPL-2.1-or-later' }
			: { name: 'ffmpeg.wasm', license: 'GPL-2.0-or-later' };
	/** Whether this browser lets the app keep files (OPFS); null until asked. */
	let canStore = $state<boolean | null>(null);
	/** Library item ids started from this page, newest first. */
	let started = $state<string[]>([]);
	const startedItems = $derived(
		started.map((id) => library.items.find((i) => i.id === id)).filter((i) => i !== undefined)
	);

	async function download(format: FormatInfo) {
		if (!session.result?.ok) return;
		const item = await library.add(session.result.info, format);
		started = [item.id, ...started];
	}

	async function downloadMerged() {
		if (!session.result?.ok || !merge) return;
		const item = await library.addMerged(session.result.info, merge);
		started = [item.id, ...started];
	}

	onMount(() => {
		session.boot().catch(() => {});
		void library.mergeAvailable().then((available) => (canMerge = available));
		void opfsAvailable().then((available) => (canStore = available));
		return () => session.dispose();
	});

	let input = $state('');
	const ytdlp = WHEELS.find((w) => w.name === 'yt-dlp')!;
	const STAGE: Record<BootStage, string> = {
		runtime: 'Loading the Python runtime…',
		wheels: `Installing yt-dlp ${ytdlp.version}…`,
		'yt-dlp': 'Starting yt-dlp…',
		ready: `yt-dlp ${ytdlp.version} ready`
	};

	const video = $derived(session.result?.ok ? primaryVideo(session.result.info) : null);
	/** yt-dlp's bv*+ba: the best separate video and audio streams, to merge here. */
	const merge = $derived(video?.formats ? bestMergePair(video.formats) : null);
	const mergeSize = $derived.by(() => {
		const sizes = merge ? [sizeOf(merge.video), sizeOf(merge.audio)] : [];
		if (!sizes.length || sizes.some((s) => !s)) return null;
		return {
			bytes: sizes.reduce((sum, s) => sum + s!.bytes, 0),
			approx: sizes.some((s) => s!.approx)
		};
	});
	const engineStatus = $derived(
		session.engineState === 'failed'
			? `The engine failed to start: ${session.engineError}`
			: session.bootStage
				? STAGE[session.bootStage]
				: 'Waiting to start…'
	);

	function submit(event: SubmitEvent) {
		event.preventDefault();
		void session.extract(input);
	}
</script>

<svelte:head>
	<title>yt-dlp-web</title>
</svelte:head>

<h1>Download</h1>
<p class="lede">
	yt-dlp runs right here, in your browser. Only raw bytes pass through the relay; everything you
	download stays in this browser's private storage.
</p>

<form onsubmit={submit} aria-describedby="engine-status">
	<label for="url">Video URL</label>
	<div class="row">
		<input
			id="url"
			name="url"
			type="text"
			inputmode="url"
			autocomplete="off"
			spellcheck="false"
			placeholder="https://www.youtube.com/watch?v=…"
			bind:value={input}
			aria-invalid={session.inputError ? 'true' : undefined}
			aria-describedby={session.inputError ? 'url-error' : undefined}
		/>
		<button
			class="primary"
			type="submit"
			disabled={session.busy || session.engineState === 'failed'}
		>
			{session.busy ? 'Fetching…' : 'Fetch formats'}
		</button>
	</div>
	{#if session.inputError}<p id="url-error" class="error">{session.inputError}</p>{/if}
</form>

<p
	id="engine-status"
	class="status"
	class:failed={session.engineState === 'failed'}
	role="status"
	data-engine-state={session.engineState}
>
	{engineStatus}
</p>
{#if canStore === false}
	<p class="status note" data-storage="unavailable">
		This browser gives the page no private file storage here — private windows often don't — so
		downloads can't be kept. You can still look up formats.
	</p>
{/if}
{#if session.solverAvailable === false}
	<p class="status note" data-solver="unavailable">
		This relay cannot solve YouTube's JavaScript challenges (it needs a Worker Loader binding), so
		yt-dlp uses YouTube clients that don't need them — some formats may be missing.
	</p>
{/if}

{#if session.log.length}
	<details class="log" open={session.busy}>
		<summary>yt-dlp log ({session.log.length})</summary>
		<ol aria-label="yt-dlp log">
			{#each session.log as entry, i (i)}
				<li class={entry.level}>{entry.line}</li>
			{/each}
		</ol>
	</details>
{/if}

{#if session.result && !session.result.ok}
	<p class="error" role="alert">{session.result.error}</p>
{:else if video}
	<article class="video" aria-labelledby="video-title">
		<header>
			<h2 id="video-title">{video.title}</h2>
			<p class="meta">
				{#if video.uploader}<span>{video.uploader}</span>{/if}
				{#if video.duration}<span>{formatDuration(video.duration)}</span>{/if}
				{#if video.extractor_key}<span>via {video.extractor_key}</span>{/if}
			</p>
		</header>
		{#if merge}
			<section class="best" aria-labelledby="best-title">
				<div>
					<h3 id="best-title">Best quality · {resolutionLabel(merge.video)}</h3>
					<p>
						{codecName(merge.video.vcodec) ?? 'Video'} video + {codecName(merge.audio.acodec) ??
							'audio'} audio, merged into one {merge.container.toUpperCase()} file right here — copied,
						never re-encoded{#if mergeSize}{' '}({mergeSize.approx ? '≈ ' : ''}{formatBytes(
								mergeSize.bytes
							)}){/if}.
					</p>
				</div>
				{#if canStore === false}
					<!-- Nothing can be kept here; the storage note above says why. -->
				{:else if canMerge}
					<button class="primary" type="button" onclick={downloadMerged}
						>Download best quality</button
					>
					<p class="license">
						Merging uses <a href={asset('/ffmpeg/NOTICE.txt')}>{ffmpeg.name}</a> ({ffmpeg.license}),
						loaded only when you merge.
					</p>
				{:else if canMerge === false}
					<p class="note" data-merge="unavailable">
						This deployment doesn't include ffmpeg.wasm, so separate video and audio can't be merged
						here. Pick a format with both below, or download each stream on its own.
					</p>
				{/if}
			</section>
		{/if}
		{#if video.formats?.length}
			<FormatTable
				formats={video.formats}
				recommended={video.format_id}
				onDownload={download}
				disabled={canStore === false}
			/>
		{:else}
			<p>No downloadable formats were found.</p>
		{/if}
	</article>
{/if}

{#if startedItems.length}
	<section class="started" aria-label="Downloads started here">
		<h2>Downloads</h2>
		<ul>
			{#each startedItems as item (item.id)}
				{@const live = library.live[item.id]}
				<li data-status={item.status}>
					<span class="name">{item.title} <code>[{item.formatId}]</code></span>
					<span class="state">
						{statusLabel(item.status)}{#if live && item.status === 'downloading'}
							· {progressLabel(live)}{:else if item.status === 'failed'}
							· {item.error}{/if}
					</span>
				</li>
			{/each}
		</ul>
		<p><a href={resolve('/library/')}>Open the library</a> to play, save or manage downloads.</p>
	</section>
{/if}

<style>
	h1 {
		margin-bottom: 0.25rem;
	}

	.lede {
		color: var(--muted);
		margin-top: 0;
		max-width: 46rem;
	}

	form {
		margin-top: 1.5rem;
	}

	label {
		display: block;
		font-weight: 600;
		margin-bottom: 0.35rem;
	}

	.row {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	input {
		flex: 1 1 20rem;
		min-width: 0;
		padding: 0.6rem 0.8rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--surface);
	}

	.status {
		color: var(--muted);
		font-size: 0.9rem;
	}

	.status.failed,
	.error {
		color: var(--danger);
	}

	.status.note {
		color: var(--warn);
		max-width: 46rem;
	}

	.log {
		margin: 1rem 0;
		font-size: 0.85rem;
	}

	.log ol {
		list-style: none;
		margin: 0.5rem 0 0;
		padding: 0.75rem;
		max-height: 14rem;
		overflow: auto;
		font-family: var(--mono);
		background: var(--surface-2);
		border-radius: var(--radius);
	}

	.log li.warning {
		color: var(--warn);
	}

	.log li.error {
		color: var(--danger);
	}

	.video {
		margin-top: 1.5rem;
	}

	.video h2 {
		margin: 0 0 0.25rem;
	}

	.meta {
		display: flex;
		gap: 1rem;
		color: var(--muted);
		margin: 0 0 1rem;
	}

	.best {
		display: grid;
		grid-template-columns: 1fr auto;
		align-items: center;
		gap: 0.25rem 1rem;
		margin-bottom: 1rem;
		padding: 0.75rem 1rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--accent) 6%, var(--surface));
	}

	.best h3 {
		font-size: 1rem;
		margin: 0;
	}

	.best p {
		margin: 0.2rem 0 0;
		color: var(--muted);
		font-size: 0.9rem;
	}

	.best .license,
	.best .note {
		grid-column: 1 / -1;
		font-size: 0.8rem;
	}

	.best .note {
		color: var(--warn);
	}

	@media (max-width: 40rem) {
		.best {
			grid-template-columns: 1fr;
		}
	}

	.started {
		margin-top: 1.5rem;
		padding: 0.75rem 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}

	.started h2 {
		font-size: 1rem;
		margin: 0 0 0.5rem;
	}

	.started ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.35rem;
	}

	.started li {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		font-size: 0.9rem;
	}

	.started .state {
		color: var(--muted);
	}

	.started li[data-status='complete'] .state {
		color: var(--ok);
	}

	.started li[data-status='failed'] .state {
		color: var(--danger);
	}
</style>
