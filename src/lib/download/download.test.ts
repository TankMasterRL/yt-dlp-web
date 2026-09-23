// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { DownloadPlan } from '$lib/formats';
import type { RelayFetchRequest, RelayFetchResponse } from '$lib/relay/client';
import { DownloadFailure, downloadToSink, type ByteSink } from './download';

const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

function memorySink(initial = new Uint8Array()): ByteSink & { bytes(): Uint8Array } {
	let data = new Uint8Array(initial);
	return {
		size: () => data.length,
		write(chunk, at) {
			if (at + chunk.length > data.length) {
				const grown = new Uint8Array(at + chunk.length);
				grown.set(data);
				data = grown;
			}
			data.set(chunk, at);
		},
		truncate(size) {
			data = data.slice(0, size);
		},
		flush() {},
		bytes: () => data
	};
}

interface ServerOptions {
	ignoreRange?: boolean;
	status?: number;
	redirectFrom?: string;
	wrongStart?: boolean;
	/** Deliver each response body in small pieces, as a network does. */
	piece?: number;
}

/** A relay fetcher serving BYTES at media.test, honouring Range. */
function server(options: ServerOptions = {}) {
	const calls: RelayFetchRequest[] = [];
	const fetcher = vi.fn(async (req: RelayFetchRequest): Promise<RelayFetchResponse> => {
		calls.push(req);
		if (options.redirectFrom && req.url === options.redirectFrom) {
			return { status: 302, headers: [['location', 'https://media.test/v.webm']], body: null };
		}
		if (options.status) return { status: options.status, headers: [], body: null };
		const range = new Headers(req.headers).get('Range')?.match(/bytes=(\d+)-(\d*)/);
		if (!range || options.ignoreRange) {
			return {
				status: 200,
				headers: [['content-length', String(BYTES.length)]],
				body: stream(BYTES, options.piece)
			};
		}
		const start = Number(range[1]);
		if (start >= BYTES.length) {
			return { status: 416, headers: [['content-range', `bytes */${BYTES.length}`]], body: null };
		}
		const end = Math.min(range[2] ? Number(range[2]) : BYTES.length - 1, BYTES.length - 1);
		const from = options.wrongStart ? 0 : start;
		return {
			status: 206,
			headers: [['content-range', `bytes ${from}-${end}/${BYTES.length}`]],
			body: stream(BYTES.slice(from, end + 1), options.piece)
		};
	});
	return { fetcher, calls };
}

function stream(bytes: Uint8Array, piece = 64): ReadableStream<Uint8Array> {
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) return controller.close();
			controller.enqueue(bytes.slice(offset, offset + piece));
			offset += piece;
		}
	});
}

const plan = (overrides: Partial<DownloadPlan> = {}): DownloadPlan => ({
	formatId: '18',
	url: 'https://media.test/v.webm',
	ext: 'webm',
	headers: [['User-Agent', 'yt-dlp-web']],
	chunkSize: 300,
	expectedBytes: null,
	...overrides
});

describe('downloadToSink', () => {
	it('downloads in ranged chunks, sending the format headers each time', async () => {
		const { fetcher, calls } = server();
		const sink = memorySink();
		const progress = vi.fn();
		const result = await downloadToSink(plan(), sink, fetcher, { onProgress: progress });
		expect(result.bytesTotal).toBe(1000);
		expect(sink.bytes()).toEqual(BYTES);
		expect(calls.map((c) => new Headers(c.headers).get('Range'))).toEqual([
			'bytes=0-299',
			'bytes=300-599',
			'bytes=600-899',
			'bytes=900-1199'
		]);
		expect(calls.every((c) => new Headers(c.headers).get('User-Agent') === 'yt-dlp-web')).toBe(
			true
		);
		expect(progress).toHaveBeenLastCalledWith({ bytesDone: 1000, bytesTotal: 1000 });
	});

	it('resumes from what is already on disk', async () => {
		const { fetcher, calls } = server();
		const sink = memorySink(BYTES.slice(0, 650));
		await downloadToSink(plan(), sink, fetcher);
		expect(new Headers(calls[0].headers).get('Range')).toBe('bytes=650-949');
		expect(sink.bytes()).toEqual(BYTES);
	});

	it('restarts from zero when the server ignores Range', async () => {
		const { fetcher } = server({ ignoreRange: true });
		const sink = memorySink(new Uint8Array(400).fill(7));
		const result = await downloadToSink(plan(), sink, fetcher);
		expect(result.bytesTotal).toBe(1000);
		expect(sink.bytes()).toEqual(BYTES);
	});

	it('follows redirects tunnelled by the relay', async () => {
		const { fetcher, calls } = server({ redirectFrom: 'https://edge.test/v.webm' });
		const sink = memorySink();
		await downloadToSink(plan({ url: 'https://edge.test/v.webm' }), sink, fetcher);
		expect(calls[1].url).toBe('https://media.test/v.webm');
		// Later chunks go straight to where the redirect led.
		expect(calls.slice(1).every((c) => c.url === 'https://media.test/v.webm')).toBe(true);
		expect(sink.bytes()).toEqual(BYTES);
	});

	it('treats a 416 at the very end as already complete', async () => {
		const { fetcher } = server();
		const sink = memorySink(BYTES);
		expect((await downloadToSink(plan(), sink, fetcher)).bytesTotal).toBe(1000);
	});

	it('refuses a range the server did not ask for', async () => {
		const { fetcher } = server({ wrongStart: true });
		const sink = memorySink(BYTES.slice(0, 300));
		await expect(downloadToSink(plan(), sink, fetcher)).rejects.toThrow(/unexpected range/);
	});

	it('explains that expired links need fresh formats', async () => {
		const { fetcher } = server({ status: 403 });
		const failure = downloadToSink(plan(), memorySink(), fetcher);
		await expect(failure).rejects.toBeInstanceOf(DownloadFailure);
		await expect(failure).rejects.toThrow(/HTTP 403.*expired/);
	});

	it('stops on abort, keeping what was written so it can resume', async () => {
		const controller = new AbortController();
		const { fetcher } = server({ piece: 10 });
		const sink = memorySink();
		const failure = downloadToSink(plan(), sink, fetcher, {
			signal: controller.signal,
			onProgress: ({ bytesDone }) => {
				if (bytesDone >= 350) controller.abort();
			}
		});
		await expect(failure).rejects.toMatchObject({ name: 'AbortError' });
		expect(sink.size()).toBeGreaterThanOrEqual(350);
		expect(sink.bytes()).toEqual(BYTES.slice(0, sink.size()));
	});

	it('rejects a body that ends short of the advertised size', async () => {
		const fetcher = async (): Promise<RelayFetchResponse> => ({
			status: 200,
			headers: [['content-length', '1000']],
			body: stream(BYTES.slice(0, 500))
		});
		await expect(downloadToSink(plan({ chunkSize: null }), memorySink(), fetcher)).rejects.toThrow(
			/500 of 1000 bytes/
		);
	});
});
