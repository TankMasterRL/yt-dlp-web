/**
 * Fetch one media format into a byte sink, in ranged chunks through the relay.
 *
 * Pure logic over two seams — the relay fetcher and the sink — so every edge is
 * unit-tested: resume from what is already on disk, servers that ignore Range,
 * relay-tunnelled redirects, 416 at the end, a short body. The download worker
 * wires it to relayFetch and an OPFS sync access handle.
 */
import type { DownloadPlan } from '$lib/formats';
import type { RelayFetchRequest, RelayFetchResponse } from '$lib/relay/client';
import type { HeaderList } from '$lib/relay/protocol';

/** Random-access bytes on disk (an OPFS FileSystemSyncAccessHandle in the worker). */
export interface ByteSink {
	size(): number;
	write(bytes: Uint8Array, at: number): void;
	truncate(size: number): void;
	flush(): void;
}

export interface DownloadProgress {
	bytesDone: number;
	bytesTotal: number | null;
}

export type RelayFetcher = (request: RelayFetchRequest) => Promise<RelayFetchResponse>;

export class DownloadFailure extends Error {
	override name = 'DownloadFailure';
}

/** Big enough to be efficient, small enough that a pause loses little. */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 10;

export async function downloadToSink(
	plan: DownloadPlan,
	sink: ByteSink,
	fetcher: RelayFetcher,
	options: { signal?: AbortSignal; onProgress?: (progress: DownloadProgress) => void } = {}
): Promise<{ bytesTotal: number }> {
	const { signal, onProgress = () => {} } = options;
	const chunk = plan.chunkSize ?? DEFAULT_CHUNK_BYTES;
	let url = plan.url;
	let offset = sink.size();
	let total: number | null = null;

	for (;;) {
		signal?.throwIfAborted();
		const range = `bytes=${offset}-${offset + chunk - 1}`;
		const response = await fetchFollowing(url, [...plan.headers, ['Range', range]], fetcher, signal);
		url = response.url;
		const headers = new Headers(response.headers);

		if (response.status === 416) {
			const size = Number(headers.get('content-range')?.match(/\/(\d+)$/)?.[1]);
			await response.body?.cancel();
			if (size === offset) break;
			throw new DownloadFailure(`server refused range ${range} (size ${size || 'unknown'})`);
		}

		if (response.status === 200) {
			// The server ignored Range and is sending the whole file: start over.
			if (offset > 0) sink.truncate(0);
			offset = 0;
			const length = Number(headers.get('content-length'));
			total = Number.isFinite(length) && length > 0 ? length : null;
			offset = await drain(response.body, sink, offset, total, onProgress, signal);
			if (total !== null && offset !== total) {
				throw new DownloadFailure(`body ended early: got ${offset} of ${total} bytes`);
			}
			total = offset;
			break;
		}

		if (response.status !== 206) {
			await response.body?.cancel();
			throw httpFailure(response.status);
		}

		const contentRange = headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
		if (!contentRange || Number(contentRange[1]) !== offset) {
			await response.body?.cancel();
			throw new DownloadFailure(
				`unexpected range from server: asked for ${range}, got ${headers.get('content-range')}`
			);
		}
		total = contentRange[3] === '*' ? null : Number(contentRange[3]);
		const expectedEnd = Number(contentRange[2]) + 1;
		offset = await drain(response.body, sink, offset, total, onProgress, signal);
		if (offset !== expectedEnd) {
			throw new DownloadFailure(`body ended early: got ${offset} of ${expectedEnd} bytes`);
		}
		if (total !== null && offset >= total) break;
	}

	sink.flush();
	onProgress({ bytesDone: offset, bytesTotal: total ?? offset });
	return { bytesTotal: offset };
}

/** Follow redirects the relay tunnelled back as data; each hop is a new relay request. */
async function fetchFollowing(
	start: string,
	headers: HeaderList,
	fetcher: RelayFetcher,
	signal?: AbortSignal
): Promise<RelayFetchResponse & { url: string }> {
	let url = start;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const response = await fetcher({ url, headers, signal });
		const location = new Headers(response.headers).get('location');
		if (response.status >= 300 && response.status < 400 && location) {
			await response.body?.cancel();
			url = new URL(location, url).href;
			continue;
		}
		return { ...response, url };
	}
	throw new DownloadFailure(`too many redirects fetching ${start}`);
}

async function drain(
	body: ReadableStream<Uint8Array> | null,
	sink: ByteSink,
	start: number,
	total: number | null,
	onProgress: (progress: DownloadProgress) => void,
	signal?: AbortSignal
): Promise<number> {
	let offset = start;
	if (!body) return offset;
	const reader = body.getReader();
	try {
		for (;;) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			if (done) return offset;
			sink.write(value, offset);
			offset += value.byteLength;
			onProgress({ bytesDone: offset, bytesTotal: total });
		}
	} finally {
		reader.releaseLock();
	}
}

function httpFailure(status: number): DownloadFailure {
	const hint =
		status === 403 || status === 410
			? ' — the media link has probably expired; fetch the formats again'
			: '';
	return new DownloadFailure(`HTTP ${status}${hint}`);
}
