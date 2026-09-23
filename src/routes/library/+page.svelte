<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { appEndpoints } from '$lib/endpoints';
	import { formatBytes, formatDuration } from '$lib/formats';
	import type { LibraryItem } from '$lib/storage/db';
	import { getLibrary } from '$lib/storage/instance';
	import { exportFileName, progressLabel, statusLabel } from '$lib/storage/present';
	import PlayerDialog from '$lib/ui/PlayerDialog.svelte';

	const library = getLibrary(appEndpoints());

	type Sort = 'newest' | 'oldest' | 'title' | 'size';
	let query = $state('');
	let sort = $state<Sort>('newest');
	let storage = $state<{ usage: number; quota: number } | null>(null);
	let persisted = $state<boolean | null>(null);
	let playing = $state<{ item: LibraryItem; file: File } | null>(null);
	let confirmDelete = $state<string | null>(null);
	let notice = $state<string | null>(null);
	const thumbnails = new Map<string, string>();

	onMount(() => {
		void library.load();
		void refreshStorage();
		return () => thumbnails.forEach((url) => URL.revokeObjectURL(url));
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

	async function refreshStorage() {
		// Some engines and private windows offer no storage manager at all.
		if (!navigator.storage) return;
		const estimate = await navigator.storage.estimate();
		storage = { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
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

	async function save(item: LibraryItem) {
		const file = await library.file(item.id);
		const name = exportFileName(item);
		const picker = (
			window as {
				showSaveFilePicker?: (o: { suggestedName: string }) => Promise<FileSystemFileHandle>;
			}
		).showSaveFilePicker;
		if (picker) {
			try {
				const handle = await picker({ suggestedName: name });
				const writable = await handle.createWritable();
				await writable.write(file);
				await writable.close();
				return;
			} catch (e) {
				if ((e as DOMException).name === 'AbortError') return;
				// Fall through to a plain download.
			}
		}
		const url = URL.createObjectURL(file);
		const link = document.createElement('a');
		link.href = url;
		link.download = name;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	}

	async function remove(item: LibraryItem) {
		confirmDelete = null;
		await library.remove(item.id);
		const url = thumbnails.get(item.id);
		if (url) URL.revokeObjectURL(url);
		thumbnails.delete(item.id);
		void refreshStorage();
	}
</script>

<svelte:head>
	<title>Library · yt-dlp-web</title>
</svelte:head>

<h1>Library</h1>
<p class="lede">
	Everything you download is kept in this browser's private storage — nothing is uploaded anywhere.
</p>

<section class="storage" aria-label="Storage">
	{#if storage}
		<meter min="0" max={storage.quota || 1} value={storage.usage} aria-label="Storage used"></meter>
		<span>{formatBytes(storage.usage)} used of {formatBytes(storage.quota)} available</span>
	{/if}
	{#if persisted}
		<span class="persisted">Storage is persistent: the browser won't evict your downloads.</span>
	{:else if persisted === false}
		<button type="button" onclick={keepDownloads}>Keep my downloads</button>
	{/if}
	{#if notice}<p class="notice" role="status">{notice}</p>{/if}
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

	<ul class="items" aria-label="Downloads">
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
							{#if item.uploader}<span>{item.uploader}</span>{/if}
							{#if item.duration}<span>{formatDuration(item.duration)}</span>{/if}
							<span>{item.resolution}</span>
							<span>{item.ext}</span>
						</p>
						<p class="status">
							<span class="badge {item.status}">{statusLabel(item.status)}</span>
							{#if item.status === 'downloading'}
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
						{:else if item.status !== 'merging'}
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
		Nothing here yet. <a href={resolve('/')}>Download something</a> and it will appear here.
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
