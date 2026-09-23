import { describe, expect, it, vi } from 'vitest';
import type { MergeRequest } from '$lib/storage/library.svelte';
import { serveWorker, type WorkerHandlers } from '$lib/workers/protocol';
import { workerRemuxer, type RemuxLoad, type RemuxWork } from './client';

type Handlers = WorkerHandlers<RemuxLoad, RemuxWork, { bytesTotal: number }, never>;

/** Spawns protocol-speaking fake workers over real MessageChannels, and records them. */
function fakeWorkers(handlers: () => Handlers) {
	const spawned: { loads: RemuxLoad[]; terminated: boolean }[] = [];
	const spawn = () => {
		const { port1, port2 } = new MessageChannel();
		const record = { loads: [] as RemuxLoad[], terminated: false };
		const h = handlers();
		serveWorker<RemuxLoad, RemuxWork, { bytesTotal: number }, never>(
			{
				async load(load, progress) {
					record.loads.push(load);
					await h.load(load, progress);
				},
				work: h.work
			},
			port2
		);
		port2.start();
		spawned.push(record);
		return Object.assign(port1, {
			terminate() {
				record.terminated = true;
				port1.close();
				port2.close();
			}
		});
	};
	return { spawn, spawned };
}

const request: MergeRequest = {
	itemId: 'id1',
	video: 'v',
	audio: 'a',
	output: 'o',
	container: 'webm'
};
const noFetch = vi.fn<typeof fetch>();

describe('workerRemuxer', () => {
	it('starts a worker for a merge and stops it once idle', async () => {
		const work = vi.fn(async () => ({ bytesTotal: 5 }));
		const { spawn, spawned } = fakeWorkers(() => ({ load: async () => {}, work }));
		const remuxer = workerRemuxer('https://app.test/base/', { spawn, fetch: noFetch });
		expect(spawned).toHaveLength(0);

		expect(await remuxer.merge(request)).toEqual({ bytesTotal: 5 });
		expect(work).toHaveBeenCalledWith({ request }, expect.any(Function));
		expect(spawned).toEqual([
			{ loads: [{ assetsBase: 'https://app.test/base/' }], terminated: true }
		]);
	});

	it('shares one worker between overlapping merges', async () => {
		const releases: (() => void)[] = [];
		const { spawn, spawned } = fakeWorkers(() => ({
			load: async () => {},
			work: () => new Promise((resolve) => releases.push(() => resolve({ bytesTotal: 1 })))
		}));
		const remuxer = workerRemuxer('https://app.test/', { spawn, fetch: noFetch });
		const first = remuxer.merge(request);
		const second = remuxer.merge({ ...request, itemId: 'id2' });
		await vi.waitFor(() => expect(releases).toHaveLength(2));
		releases[0]();
		await first;
		expect(spawned[0].terminated).toBe(false);
		releases[1]();
		await second;
		expect(spawned).toHaveLength(1);
		expect(spawned[0].terminated).toBe(true);
	});

	it('fails the merge when ffmpeg cannot load, and tries afresh next time', async () => {
		let attempt = 0;
		const { spawn, spawned } = fakeWorkers(() => {
			const failing = ++attempt === 1;
			return {
				load: async () => {
					if (failing) throw new TypeError('Failed to fetch dynamically imported module');
				},
				work: async () => ({ bytesTotal: 2 })
			};
		});
		const remuxer = workerRemuxer('https://app.test/', { spawn, fetch: noFetch });
		await expect(remuxer.merge(request)).rejects.toThrow(
			'Failed to fetch dynamically imported module'
		);
		expect(await remuxer.merge(request)).toEqual({ bytesTotal: 2 });
		expect(spawned.map((s) => s.terminated)).toEqual([true, true]);
	});

	it("is available when the deployment serves ffmpeg's wasm; asks once", async () => {
		const ok = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		const remuxer = workerRemuxer('https://app.test/base/', { fetch: ok });
		expect(await remuxer.available()).toBe(true);
		expect(await remuxer.available()).toBe(true);
		expect(ok).toHaveBeenCalledTimes(1);
		expect(ok).toHaveBeenCalledWith(new URL('https://app.test/base/ffmpeg/ffmpeg-core.wasm'), {
			method: 'HEAD'
		});

		const missing = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
		expect(await workerRemuxer('https://app.test/', { fetch: missing }).available()).toBe(false);
		const offline = vi.fn<typeof fetch>(async () =>
			Promise.reject(new TypeError('Failed to fetch'))
		);
		expect(await workerRemuxer('https://app.test/', { fetch: offline }).available()).toBe(false);
	});
});
