// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ByteSink } from './download';
import { copyToSink } from './copy';

const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

function memorySink(
	initial = new Uint8Array()
): ByteSink & { bytes(): Uint8Array; flushed: number } {
	let data = new Uint8Array(initial);
	const sink = {
		flushed: 0,
		size: () => data.length,
		write(chunk: Uint8Array, at: number) {
			if (at + chunk.length > data.length) {
				const grown = new Uint8Array(at + chunk.length);
				grown.set(data);
				data = grown;
			}
			data.set(chunk, at);
		},
		truncate(size: number) {
			data = data.slice(0, size);
		},
		flush() {
			sink.flushed++;
		},
		bytes: () => data
	};
	return sink;
}

describe('copyToSink', () => {
	it('copies a file byte for byte, a chunk at a time, and flushes', async () => {
		const sink = memorySink();
		const write = vi.spyOn(sink, 'write');
		const result = await copyToSink(new Blob([BYTES]), sink, { chunkBytes: 300 });
		expect(result).toEqual({ bytesTotal: 1000 });
		expect(sink.bytes()).toEqual(BYTES);
		expect(write.mock.calls.map(([chunk, at]) => [at, chunk.byteLength])).toEqual([
			[0, 300],
			[300, 300],
			[600, 300],
			[900, 100]
		]);
		expect(sink.flushed).toBe(1);
	});

	it('starts over in a file that already holds bytes: an import never resumes', async () => {
		const sink = memorySink(new Uint8Array(1500).fill(7));
		await copyToSink(new Blob([BYTES]), sink, { chunkBytes: 400 });
		expect(sink.bytes()).toEqual(BYTES);
	});

	it('reports progress after every chunk, ending at the whole size', async () => {
		const onProgress = vi.fn();
		await copyToSink(new Blob([BYTES]), memorySink(), { chunkBytes: 400, onProgress });
		expect(onProgress.mock.calls.map(([p]) => p)).toEqual([
			{ bytesDone: 400, bytesTotal: 1000 },
			{ bytesDone: 800, bytesTotal: 1000 },
			{ bytesDone: 1000, bytesTotal: 1000 }
		]);
	});

	it('copies an empty file as an empty file', async () => {
		const sink = memorySink(new Uint8Array(3));
		expect(await copyToSink(new Blob([]), sink)).toEqual({ bytesTotal: 0 });
		expect(sink.bytes()).toEqual(new Uint8Array());
	});

	it('stops between chunks when aborted, with an AbortError', async () => {
		const controller = new AbortController();
		const sink = memorySink();
		const onProgress = vi.fn(() => controller.abort());
		await expect(
			copyToSink(new Blob([BYTES]), sink, {
				chunkBytes: 300,
				signal: controller.signal,
				onProgress
			})
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(onProgress).toHaveBeenCalledTimes(1);
		expect(sink.bytes().length).toBe(300);
	});

	it('fails, rather than spinning, when the file holds less than its size said', async () => {
		const shrunk = {
			size: 10,
			slice: () => new Blob([])
		} as unknown as Blob;
		await expect(copyToSink(shrunk, memorySink())).rejects.toThrow(
			'The file changed while it was being imported'
		);
	});

	it('fails when the file cannot be read any more (it changed on disk after it was picked)', async () => {
		const unreadable = {
			size: 10,
			slice: () => ({
				arrayBuffer: () =>
					Promise.reject(new DOMException('The file could not be read', 'NotReadableError'))
			})
		} as unknown as Blob;
		await expect(copyToSink(unreadable, memorySink())).rejects.toMatchObject({
			name: 'NotReadableError'
		});
	});
});
