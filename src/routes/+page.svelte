<script lang="ts">
	import { base } from '$app/paths';
	import { onMount } from 'svelte';
	import { spawnEngine } from '$lib/engine/client';
	import type { BootStage } from '$lib/engine/runtime';
	import { ExtractSession } from '$lib/engine/session.svelte';
	import { WHEELS } from '$lib/engine/wheels';
	import { formatDuration, primaryVideo } from '$lib/formats';
	import { relayEndpoint, solveEndpoint } from '$lib/relay/client';
	import FormatTable from '$lib/ui/FormatTable.svelte';

	// Resolved here, in browser-only code: workers get absolute URLs in `load`.
	const relayUrl = import.meta.env.VITE_RELAY_URL;
	const session = new ExtractSession(spawnEngine, {
		assetsBase: new URL(`${base}/`, location.href).href,
		relayEndpoint: new URL(relayEndpoint(relayUrl), location.href).href,
		solveEndpoint: new URL(solveEndpoint(relayUrl), location.href).href
	});

	onMount(() => {
		session.boot().catch(() => {});
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
	yt-dlp runs right here, in your browser. Only raw bytes pass through the relay; everything
	you download stays in this browser's private storage.
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
		<button class="primary" type="submit" disabled={session.busy || session.engineState === 'failed'}>
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
		{#if video.formats?.length}
			<FormatTable formats={video.formats} recommended={video.format_id} />
		{:else}
			<p>No downloadable formats were found.</p>
		{/if}
	</article>
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
</style>
