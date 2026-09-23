<script lang="ts">
	import type { FormatInfo } from '$lib/engine/runtime';
	import {
		formatBytes,
		formatKind,
		formatsBestFirst,
		isDownloadable,
		resolutionLabel,
		sizeOf,
		type FormatKind
	} from '$lib/formats';

	interface Props {
		formats: FormatInfo[];
		/** The format yt-dlp selects by default (muxed first). */
		recommended?: string;
		onDownload?: (format: FormatInfo) => void;
		disabled?: boolean;
	}

	let { formats, recommended, onDownload, disabled = false }: Props = $props();

	const rows = $derived(formatsBestFirst(formats));
	const KIND_LABEL: Record<FormatKind, string> = {
		av: 'Video + audio',
		video: 'Video only',
		audio: 'Audio only'
	};

	function codecs(format: FormatInfo): string {
		const list = [format.vcodec, format.acodec].filter((c) => c && c !== 'none');
		return list.length ? list.join(' · ') : '—';
	}
</script>

<div class="scroller">
	<table>
		<caption class="visually-hidden">Available formats</caption>
		<thead>
			<tr>
				<th scope="col">Format</th>
				<th scope="col">Type</th>
				<th scope="col">Quality</th>
				<th scope="col">Container</th>
				<th scope="col">Codecs</th>
				<th scope="col">Size</th>
				{#if onDownload}<th scope="col"><span class="visually-hidden">Action</span></th>{/if}
			</tr>
		</thead>
		<tbody>
			{#each rows as format (format.format_id)}
				{@const kind = formatKind(format)}
				{@const size = sizeOf(format)}
				<tr class:recommended={format.format_id === recommended}>
					<td>
						<code>{format.format_id}</code>
						{#if format.format_id === recommended}<span class="badge">recommended</span>{/if}
					</td>
					<td><span class="kind {kind}">{KIND_LABEL[kind]}</span></td>
					<td>{resolutionLabel(format)}</td>
					<td>{format.ext ?? '—'}</td>
					<td class="codecs">{codecs(format)}</td>
					<td class="size">{size ? `${size.approx ? '≈ ' : ''}${formatBytes(size.bytes)}` : '—'}</td
					>
					{#if onDownload}
						<td class="action">
							{#if isDownloadable(format)}
								<button
									type="button"
									{disabled}
									aria-label="Download format {format.format_id}"
									onclick={() => onDownload(format)}>Download</button
								>
							{:else}
								<span
									class="unsupported"
									title="Streaming ({format.protocol}) formats are not supported yet">stream</span
								>
							{/if}
						</td>
					{/if}
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.scroller {
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.92rem;
	}

	th,
	td {
		padding: 0.55rem 0.75rem;
		text-align: left;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}

	th {
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
		background: var(--surface-2);
	}

	tbody tr:last-child td {
		border-bottom: 0;
	}

	tr.recommended {
		background: color-mix(in srgb, var(--accent) 8%, transparent);
	}

	.badge {
		margin-left: 0.4rem;
		font-size: 0.72rem;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		background: var(--accent);
		color: var(--accent-text);
	}

	.kind {
		font-size: 0.8rem;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		background: var(--surface-2);
	}

	.kind.av {
		color: var(--ok);
	}

	.codecs {
		font-family: var(--mono);
		font-size: 0.8rem;
		color: var(--muted);
	}

	.size,
	.action {
		text-align: right;
	}

	.unsupported {
		color: var(--muted);
		font-size: 0.8rem;
	}
</style>
