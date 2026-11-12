<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { appEndpoints } from '$lib/endpoints';
	import { formatBytes, formatDuration } from '$lib/formats';
	import type { LibraryItem } from '$lib/storage/db';
	import { importedTitle } from '$lib/storage/imported';
	import { getLibrary, opfsAvailable } from '$lib/storage/instance';
	import { exportFileName, libraryBytes, progressLabel, statusLabel } from '$lib/storage/present';
	import AnimationDialog from '$lib/ui/AnimationDialog.svelte';
	import PlayerDialog from '$lib/ui/PlayerDialog.svelte';
	import { saveFile } from '$lib/ui/save';

	const endpoints = appEndpoints();
	const library = getLibrary(endpoints);
	/** What the file pickers offer: what browsers commonly play, and Matroska, which some systems type as nothing. */
	const MEDIA_FILES = 'video/*,audio/*,.mkv,.mka,.webm,.opus';
	const VIDEO_FILES = 'video/*,.mkv,.webm';

	type Sort = 'newest' | 'oldest' | 'title' | 'size';
	let query = $state('');
	let sort = $state<Sort>('newest');
	/** How much more the browser lets this site store; null where it won't say. */
	let room = $state<number | null>(null);
	let persisted = $state<boolean | null>(null);
	let playing = $state<{ item: LibraryItem; file: File } | null>(null);
	/** The video in the animation maker: a library item's, or a file opened straight from disk. */
	let animating = $state<{ item: { title: string; formatId?: string }; file: File } | null>(null);
	/** Whether this browser lets the app keep files (OPFS); null until asked. */
	let canStore = $state<boolean | null>(null);
	let importErrors = $state<string[]>([]);
	/** The picked file the browser is opening, before it is imported. */
	let opening = $state<string | null>(null);
	let importInput: HTMLInputElement;
	let animateInput: HTMLInputElement;
	let confirmDelete = $state<string | null>(null);
	let notice = $state<string | null>(null);
	const thumbnails = new Map<string, string>();

	onMount(() => {
		void library.load();
		void opfsAvailable().then((available) => (canStore = available));
		return () => thumbnails.forEach((url) => URL.revokeObjectURL(url));
	});

	/** What the library itself keeps here: its files, as far as written, and thumbnails. */
	const used = $derived(libraryBytes(library.items, library.live));
	// The room left follows the library: it is read again whenever an item comes, goes or
	// changes status (not on every progress report).
	const shape = $derived(library.items.map((i) => `${i.id}:${i.status}`).join());
	$effect(() => {
		void shape;
		void refreshStorage();
	});

	const visible = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const matches = library.items.filter(
			(i) => !q || i.title.toLowerCase().includes(q) || i.uploader?.toLowerCase().includes(q)
		);
		const by: Record<Sort, (a: LibraryItem, b: LibraryItem) => number> = {
			newest: (a, b) => b.createdAt - a.createdAt,
			oldest: (a, b) => a.createdAt - b.createdAt,
			title: (a, b) => a.title.localeCompare(b.title),
			size: (a, b) => (b.bytesTotal ?? b.bytesDone) - (a.bytesTotal ?? a.bytesDone)
		};
		return [...matches].sort(by[sort]);
	});

	/**
	 * The browser's estimate covers the whole origin — anything else served from the same
	 * address (localhost, a github.io account) — so it only says how much more fits; what
	 * the library holds is counted from the library itself.
	 */
	async function refreshStorage() {
		// Some engines and private windows offer no storage manager at all.
		if (!navigator.storage) return;
		const { usage = 0, quota = 0 } = await navigator.storage.estimate();
		room = quota ? Math.max(0, quota - usage) : null;
		persisted = await navigator.storage.persisted();
	}

	async function keepDownloads() {
		persisted = await navigator.storage.persist();
		if (!persisted)
			notice =
				'The browser declined persistent storage; it may evict downloads when space runs low.';
	}

	function thumbnailUrl(item: LibraryItem): string | null {
		if (!item.thumbnail) return null;
		let url = thumbnails.get(item.id);
		if (!url) {
			url = URL.createObjectURL(item.thumbnail);
			thumbnails.set(item.id, url);
		}
		return url;
	}

	async function play(item: LibraryItem) {
		playing = { item, file: await library.file(item.id) };
	}

	async function animate(item: LibraryItem) {
		animating = { item, file: await library.file(item.id) };
	}

	/** Import each picked file in turn: each is opened first, and copied in if the browser plays it. */
	async function importPicked() {
		const files = [...(importInput.files ?? [])];
		// Picking the same file again must fire `change` again.
		importInput.value = '';
		importErrors = [];
		for (const file of files) {
			opening = file.name;
			try {
				await library.importFile(file);
			} catch (e) {
				importErrors = [...importErrors, `${file.name} wasn't imported: ${(e as Error).message}`];
			}
		}
		opening = null;
	}

	/** Open a file in the animation maker straight from disk: nothing is copied. */
	function animatePicked() {
		const file = animateInput.files?.[0];
		animateInput.value = '';
		if (file) animating = { item: { title: importedTitle(file.name) }, file };
	}

	async function save(item: LibraryItem) {
		await saveFile(await library.file(item.id), exportFileName(item));
	}

	async function remove(item: LibraryItem) {
		confirmDelete = null;
		await library.remove(item.id);
		const url = thumbnails.get(item.id);
		if (url) URL.revokeObjectURL(url);
		thumbnails.delete(item.id);
	}
</script>

<svelte:head>
	<title>Library · yt-dlp-web</title>
</svelte:head>

<h1>Library</h1>
<p class="lede">
	Everything you {endpoints.relay ? 'download or import' : 'import'} is kept in this browser's private
	storage — nothing is uploaded anywhere.
</p>

<section class="storage" aria-label="Storage">
	{#if library.loaded}
		{#if room !== null}
			<meter min="0" max={used + room || 1} value={used} aria-label="Storage the library uses"
			></meter>
		{/if}
		<span
			>{formatBytes(used)} in your library{room === null
				? ''
				: ` · room for ${formatBytes(room)} more`}</span
		>
	{/if}
	{#if persisted}
		<span class="persisted">Storage is persistent: the browser won't evict your downloads.</span>
	{:else if persisted === false}
		<button type="button" onclick={keepDownloads}>Keep my downloads</button>
	{/if}
	{#if notice}<p class="notice" role="status">{notice}</p>{/if}
</section>

<section class="device" aria-label="Videos on this device">
	<div class="device-actions">
		<button
			type="button"
			class="primary"
			onclick={() => importInput.click()}
			disabled={canStore === false || opening !== null}>Import videos…</button
		>
		<button type="button" onclick={() => animateInput.click()}>Animate a video file…</button>
	</div>
	<p class="hint">
		Import videos you already have: they're copied into this browser's private storage, to play and
		to make animated images from. Or animate one straight from your disk, without copying it.
	</p>
	<input
		bind:this={importInput}
		type="file"
		accept={MEDIA_FILES}
		multiple
		hidden
		aria-label="Videos to import"
		onchange={importPicked}
	/>
	<input
		bind:this={animateInput}
		type="file"
		accept={VIDEO_FILES}
		hidden
		aria-label="Video to animate"
		onchange={animatePicked}
	/>
	{#if canStore === false}
		<p class="note" data-storage="unavailable">
			This browser gives the page no private file storage here — private windows often don't — so
			nothing can be imported. A video can still be animated straight from your disk.
		</p>
	{/if}
	{#if opening}<p class="hint" role="status">Opening {opening}…</p>{/if}
	{#each importErrors as error, i (i)}<p class="error" role="alert">{error}</p>{/each}
</section>

{#if library.items.length}
	<div class="controls">
		<label>
			<span class="visually-hidden">Search the library</span>
			<input type="search" placeholder="Search titles" bind:value={query} />
		</label>
		<label>
			Sort
			<select bind:value={sort}>
				<option value="newest">Newest</option>
				<option value="oldest">Oldest</option>
				<option value="title">Title</option>
				<option value="size">Size</option>
			</select>
		</label>
	</div>

	<ul class="items" aria-label="Library items">
		{#each visible as item (item.id)}
			{@const live = library.live[item.id]}
			{@const thumb = thumbnailUrl(item)}
			<li>
				<article aria-labelledby="title-{item.id}" data-status={item.status}>
					<div class="thumb" aria-hidden="true">
						{#if thumb}<img src={thumb} alt="" />{:else}<span
								>{item.kind === 'audio' ? '♪' : '▶'}</span
							>{/if}
					</div>
					<div class="body">
						<h2 id="title-{item.id}">{item.title}</h2>
						<p class="meta">
							{#if item.origin === 'import'}<span>From this device</span>
							{:else if item.uploader}<span>{item.uploader}</span>{/if}
							{#if item.duration}<span>{formatDuration(item.duration)}</span>{/if}
							<span>{item.resolution}</span>
							<span>{item.ext}</span>
						</p>
						<p class="status">
							<span class="badge {item.status}">{statusLabel(item.status, item.origin)}</span>
							{#if item.status === 'downloading' || item.status === 'importing'}
								{@const progress = live ?? {
									bytesDone: item.bytesDone,
									bytesTotal: item.bytesTotal
								}}
								{#if progress.bytesTotal}
									<progress max={progress.bytesTotal} value={progress.bytesDone}></progress>
								{/if}
								<span>{progressLabel(progress)}</span>
							{:else if item.status === 'complete'}
								<span>{formatBytes(item.bytesTotal ?? item.bytesDone)}</span>
							{:else if item.status === 'merging'}
								<span>Merging video and audio…</span>
							{:else if item.status === 'failed'}
								<span class="error">{item.error}</span>
							{:else}
								<span
									>{progressLabel({ bytesDone: item.bytesDone, bytesTotal: item.bytesTotal })}</span
								>
							{/if}
						</p>
					</div>
					<div class="actions">
						{#if item.status === 'complete'}
							<button
								type="button"
								class="primary"
								onclick={() => play(item)}
								aria-label="Play {item.title}">Play</button
							>
							{#if item.kind !== 'audio'}
								<button
									type="button"
									onclick={() => animate(item)}
									aria-label="Make an animated image from {item.title}">Animate</button
								>
							{/if}
							<button
								type="button"
								onclick={() => save(item)}
								aria-label="Save {item.title} to disk">Save</button
							>
						{:else if item.status === 'downloading'}
							<button
								type="button"
								onclick={() => library.pause(item.id)}
								aria-label="Pause {item.title}">Pause</button
							>
						{:else if (item.status === 'paused' || item.status === 'failed') && item.origin !== 'import'}
							<!-- An import cannot be resumed: the picked file was only lent. -->
							<button
								type="button"
								onclick={() => library.resume(item.id)}
								aria-label="Resume {item.title}">Resume</button
							>
						{/if}
						{#if item.status === 'merging'}
							<!-- ffmpeg holds the files until it finishes, in seconds. -->
						{:else if confirmDelete === item.id}
							<button
								type="button"
								class="danger"
								onclick={() => remove(item)}
								aria-label="Confirm deleting {item.title}">Confirm delete</button
							>
							<button type="button" onclick={() => (confirmDelete = null)}>Keep</button>
						{:else}
							<button
								type="button"
								onclick={() => (confirmDelete = item.id)}
								aria-label="Delete {item.title}">Delete</button
							>
						{/if}
					</div>
				</article>
			</li>
		{:else}
			<li class="empty">No downloads match “{query}”.</li>
		{/each}
	</ul>
{:else if library.loaded}
	<p class="empty">
		Nothing here yet.
		{#if endpoints.relay}<a href={resolve('/')}>Download something</a> or import videos you already have,
			and they will appear here.{:else}Import videos you already have, and they will appear here.{/if}
	</p>
{/if}

{#if playing}
	<PlayerDialog
		file={playing.file}
		title={playing.item.title}
		kind={playing.item.kind}
		onclose={() => (playing = null)}
	/>
{/if}

{#if animating}
	<AnimationDialog file={animating.file} item={animating.item} onclose={() => (animating = null)} />
{/if}

<style>
	.lede {
		color: var(--muted);
		margin-top: 0;
	}

	.storage {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		font-size: 0.9rem;
	}

	.storage meter {
		width: 10rem;
	}

	.persisted {
		color: var(--ok);
	}

	.device {
		display: grid;
		gap: 0.5rem;
		margin-top: 0.75rem;
		padding: 0.75rem 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}

	.device-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.device p {
		margin: 0;
		font-size: 0.9rem;
	}

	.device .hint {
		color: var(--muted);
	}

	.device .note {
		color: var(--warn);
	}

	.notice {
		flex-basis: 100%;
		margin: 0;
		color: var(--warn);
	}

	.controls {
		display: flex;
		gap: 0.75rem;
		margin: 1.25rem 0 0.75rem;
		flex-wrap: wrap;
	}

	.controls input,
	.controls select {
		padding: 0.45rem 0.7rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--surface);
	}

	.items {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.75rem;
	}

	article {
		display: grid;
		grid-template-columns: 8rem 1fr auto;
		gap: 1rem;
		align-items: center;
		padding: 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}

	@media (max-width: 40rem) {
		article {
			grid-template-columns: 5rem 1fr;
		}
		.actions {
			grid-column: 1 / -1;
		}
	}

	.thumb {
		aspect-ratio: 16 / 9;
		border-radius: 6px;
		overflow: hidden;
		background: var(--surface-2);
		display: grid;
		place-items: center;
		color: var(--muted);
		font-size: 1.5rem;
	}

	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	h2 {
		font-size: 1rem;
		margin: 0;
		overflow-wrap: anywhere;
	}

	.meta,
	.status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		margin: 0.25rem 0 0;
		color: var(--muted);
		font-size: 0.85rem;
	}

	.badge {
		padding: 0.05rem 0.5rem;
		border-radius: 999px;
		background: var(--surface-2);
		font-size: 0.78rem;
	}

	.badge.complete {
		color: var(--ok);
	}

	.badge.failed,
	.error {
		color: var(--danger);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		justify-content: flex-end;
	}

	button.danger {
		border-color: var(--danger);
		color: var(--danger);
	}

	.empty {
		color: var(--muted);
	}
</style>
