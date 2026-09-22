import { describe, expect, it, vi } from 'vitest';
import { WorkerClient, serveWorker, type WorkerHandlers } from './protocol';

/** Wire a client and a served "worker" over a real MessageChannel. */
function pair<L, Q, R, P>(handlers: WorkerHandlers<L, Q, R, P>) {
	const { port1, port2 } = new MessageChannel();
	serveWorker(handlers, port2);
	port2.start();
	const onProgress = vi.fn();
	const client = new WorkerClient<L, Q, R, P>(port1, onProgress);
	return { client, onProgress, port1 };
}

describe('worker protocol', () => {
	it('resolves load() on ready, forwarding load progress', async () => {
		const { client, onProgress } = pair<string, never, never, string>({
			async load(payload, progress) {
				progress(`booting ${payload}`);
			},
			work: () => {
				throw new Error('unused');
			}
		});
		await client.load('pyodide');
		expect(onProgress).toHaveBeenCalledWith('booting pyodide', undefined);
	});

	it('rejects the pending load() when loading fails — never hangs', async () => {
		const { client } = pair({
			async load() {
				throw new Error('wheel integrity check failed');
			},
			work: () => undefined
		});
		await expect(client.load(undefined)).rejects.toThrow('wheel integrity check failed');
	});

	it('matches results to calls by id, even out of order', async () => {
		const { client } = pair<void, number, number, never>({
			async load() {},
			async work(n) {
				await new Promise((r) => setTimeout(r, n === 1 ? 30 : 0));
				return n * 10;
			}
		});
		await client.load();
		const [a, b] = await Promise.all([client.call(1), client.call(2)]);
		expect([a, b]).toEqual([10, 20]);
	});

	it('forwards per-call progress with its id', async () => {
		const { client, onProgress } = pair<void, string, string, string>({
			async load() {},
			work(url, progress) {
				progress(`[generic] ${url}: Downloading webpage`);
				return 'done';
			}
		});
		await client.load();
		await client.call('https://example.test/');
		expect(onProgress).toHaveBeenCalledWith('[generic] https://example.test/: Downloading webpage', 1);
	});

	it('rejects only the failing call', async () => {
		const { client } = pair<void, boolean, string, never>({
			async load() {},
			work(fail) {
				if (fail) throw new Error('boom');
				return 'ok';
			}
		});
		await client.load();
		const results = await Promise.allSettled([client.call(true), client.call(false)]);
		expect(results[0]).toMatchObject({ status: 'rejected', reason: new Error('boom') });
		expect(results[1]).toMatchObject({ status: 'fulfilled', value: 'ok' });
	});

	it('makes calls wait for load() instead of racing it', async () => {
		let loaded = false;
		const { client } = pair<void, void, boolean, never>({
			async load() {
				await new Promise((r) => setTimeout(r, 20));
				loaded = true;
			},
			work: () => loaded
		});
		const loading = client.load();
		const result = client.call();
		await loading;
		expect(await result).toBe(true);
	});

	it('rejects outstanding calls when terminated', async () => {
		const { client } = pair<void, void, never, never>({
			async load() {},
			work: () => new Promise(() => {})
		});
		await client.load();
		const pending = client.call();
		client.terminate(new Error('engine stopped'));
		await expect(pending).rejects.toThrow('engine stopped');
	});
});
