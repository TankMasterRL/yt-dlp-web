// @vitest-environment node
import { createHash } from 'node:crypto';
import type { PyodideInterface } from 'pyodide';
import { describe, expect, it, vi } from 'vitest';
import { bootEngine, type BootStage } from './runtime';
import type { SyncTransport } from './transport';
import type { WheelPin } from './wheels';

// Two small wheels whose pins match the bytes `wheelBytes` makes.
vi.mock('./wheels', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./wheels')>();
	const pin = (name: string): WheelPin => ({
		name,
		version: '1.0',
		file: `${name}-1.0-py3-none-any.whl`,
		url: `https://files.example/${name}.whl`,
		sha256: createHash('sha256').update(`${name} wheel`).digest('hex'),
		size: 0
	});
	return { ...actual, WHEELS: [pin('first'), pin('second')] };
});

const wheelBytes = (pin: WheelPin) => new TextEncoder().encode(`${pin.name} wheel`);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

/** Just enough of Pyodide for bootEngine: what it unpacked, and what yt-dlp was installed with. */
function fakePyodide() {
	const unpacked: string[] = [];
	const install = vi.fn();
	const pyodide = {
		runPython: () => '/lib/site-packages',
		unpackArchive: (bytes: Uint8Array) => unpacked.push(new TextDecoder().decode(bytes)),
		FS: { mkdirTree: () => {}, writeFile: () => {} },
		pyimport: (name: string) =>
			name === 'ytdlp_web.bootstrap' ? { install } : { extract() {}, warm_up: () => warming }
	};
	// The warm-up generator: three slices, then done.
	let slices = 3;
	const warming = {
		next: vi.fn(() => (slices-- > 0 ? { done: false, value: undefined } : { done: true })),
		destroy: vi.fn()
	};
	return { pyodide: pyodide as unknown as PyodideInterface, unpacked, install, warming };
}

const transport: SyncTransport = () => {
	throw new Error('no network in this test');
};

/** Lets every pending callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('bootEngine', () => {
	it('fetches every wheel while the runtime is still loading', async () => {
		const { pyodide, unpacked } = fakePyodide();
		const runtime = deferred<PyodideInterface>();
		const readWheel = vi.fn(async (pin: WheelPin) => wheelBytes(pin));
		const stages: BootStage[] = [];
		const booting = bootEngine({
			loadPyodide: () => runtime.promise,
			readWheel,
			transport,
			onProgress: (stage) => stages.push(stage)
		});
		await settle();
		expect(readWheel.mock.calls.map(([pin]) => pin.name)).toEqual(['first', 'second']);
		expect(stages).toEqual(['runtime']);

		runtime.resolve(pyodide);
		await booting;
		// Unpacked in their pinned order, whichever arrived first.
		expect(unpacked).toEqual(['first wheel', 'second wheel']);
		expect(stages).toEqual(['runtime', 'wheels', 'yt-dlp', 'ready']);
	});

	it('loads the runtime and wheels before the solver is known, and installs yt-dlp once it is', async () => {
		const { pyodide, unpacked, install } = fakePyodide();
		const solver = deferred<((program: string) => string) | undefined>();
		const stages: BootStage[] = [];
		const booting = bootEngine({
			loadPyodide: async () => pyodide,
			readWheel: async (pin) => wheelBytes(pin),
			transport,
			solver: solver.promise,
			onProgress: (stage) => stages.push(stage)
		});
		await vi.waitFor(() => expect(stages).toEqual(['runtime', 'wheels', 'yt-dlp']));
		expect(unpacked).toHaveLength(2);
		await settle();
		expect(install).not.toHaveBeenCalled();

		const solve = (program: string) => program;
		solver.resolve(solve);
		await booting;
		expect(install).toHaveBeenCalledWith(transport, solve);
		expect(stages.at(-1)).toBe('ready');
	});

	it('installs yt-dlp without a solver when the deployment turns out to have none', async () => {
		const { pyodide, install } = fakePyodide();
		await bootEngine({
			loadPyodide: async () => pyodide,
			readWheel: async (pin) => wheelBytes(pin),
			transport,
			solver: Promise.resolve(undefined)
		});
		expect(install).toHaveBeenCalledWith(transport, null);
	});

	it('fails the boot with a wheel that could not be fetched while the runtime loaded', async () => {
		// Rejected long before it is awaited: vitest fails the run on an unhandled rejection.
		const { pyodide, unpacked } = fakePyodide();
		const runtime = deferred<PyodideInterface>();
		const booting = bootEngine({
			loadPyodide: () => runtime.promise,
			readWheel: async (pin) => {
				if (pin.name === 'second') throw new Error('Could not fetch second: HTTP 404');
				return wheelBytes(pin);
			},
			transport
		});
		await settle();
		runtime.resolve(pyodide);
		await expect(booting).rejects.toThrow('Could not fetch second: HTTP 404');
		expect(unpacked).toEqual(['first wheel']);
	});

	it('fails the boot with the runtime, not a wheel, when the runtime fails first', async () => {
		const booting = bootEngine({
			loadPyodide: async () => {
				throw new Error('pyodide.asm.wasm: HTTP 404');
			},
			readWheel: async () => {
				throw new Error('wheels: HTTP 404');
			},
			transport
		});
		await expect(booting).rejects.toThrow('pyodide.asm.wasm: HTTP 404');
		await settle();
	});

	it('warms up a slice per step, saying whether more remain, and lets go of the generator when done', async () => {
		const { pyodide, warming } = fakePyodide();
		const engine = await bootEngine({
			loadPyodide: async () => pyodide,
			readWheel: async (pin) => wheelBytes(pin),
			transport
		});
		const step = engine.warmUp();
		expect([step(), step(), step()]).toEqual([true, true, true]);
		expect(warming.destroy).not.toHaveBeenCalled();
		expect(step()).toBe(false);
		expect(warming.destroy).toHaveBeenCalledOnce();
		expect(step()).toBe(false);
		expect(warming.next).toHaveBeenCalledTimes(4);
	});

	it('never unpacks a wheel whose bytes are not the pinned ones', async () => {
		const { pyodide, unpacked } = fakePyodide();
		await expect(
			bootEngine({
				loadPyodide: async () => pyodide,
				readWheel: async () => new TextEncoder().encode('tampered'),
				transport
			})
		).rejects.toThrow(/Integrity check failed for first-1\.0-py3-none-any\.whl/);
		expect(unpacked).toEqual([]);
	});
});
