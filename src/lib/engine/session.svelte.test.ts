import { describe, expect, it, vi } from 'vitest';
import type { EngineLoad, EngineProgress, EngineRequest } from './client';
import type { ExtractResult } from './runtime';
import { ExtractSession, normalizeInput } from './session.svelte';

const LOAD: EngineLoad = {
	assetsBase: 'https://app.test/',
	relayEndpoint: 'https://relay.test/relay',
	solveEndpoint: 'https://relay.test/solve'
};
const OK: ExtractResult = {
	ok: true,
	info: { id: 'x', title: 'Clip', formats: [] },
	warnings: []
};

function fakeEngine(behaviour: {
	load?: () => Promise<void>;
	call?: (req: EngineRequest, progress: (p: EngineProgress) => void) => Promise<ExtractResult>;
}) {
	let progress: (p: EngineProgress) => void = () => {};
	const client = {
		load: vi.fn(async () => {
			progress({ kind: 'boot', stage: 'runtime' });
			await behaviour.load?.();
			progress({ kind: 'boot', stage: 'ready' });
		}),
		call: vi.fn(async (req: EngineRequest) => (behaviour.call ? behaviour.call(req, progress) : OK)),
		terminate: vi.fn()
	};
	const spawn = vi.fn((onProgress: (p: EngineProgress) => void) => {
		progress = onProgress;
		return client;
	});
	return { spawn, client };
}

describe('ExtractSession', () => {
	it('boots the engine once, tracking its stages', async () => {
		const { spawn, client } = fakeEngine({});
		const session = new ExtractSession(spawn, LOAD);
		expect(session.engineState).toBe('idle');
		const booting = session.boot();
		expect(session.engineState).toBe('booting');
		await Promise.all([booting, session.boot()]);
		expect(session.engineState).toBe('ready');
		expect(session.bootStage).toBe('ready');
		expect(spawn).toHaveBeenCalledOnce();
		expect(client.load).toHaveBeenCalledWith(LOAD);
	});

	it("records whether the deployment can solve YouTube's JS challenges", async () => {
		const { spawn } = fakeEngine({});
		const session = new ExtractSession(spawn, LOAD);
		expect(session.solverAvailable).toBeNull();
		const booting = session.boot();
		spawn.mock.calls[0][0]({ kind: 'capabilities', solver: false });
		await booting;
		expect(session.solverAvailable).toBe(false);
	});

	it('surfaces a failed boot instead of hanging', async () => {
		const { spawn } = fakeEngine({
			load: async () => {
				throw new Error('Integrity check failed for yt_dlp.whl');
			}
		});
		const session = new ExtractSession(spawn, LOAD);
		await expect(session.boot()).rejects.toThrow();
		expect(session.engineState).toBe('failed');
		expect(session.engineError).toMatch(/Integrity check failed/);
	});

	it('extracts, streaming the log and then the result', async () => {
		const { spawn, client } = fakeEngine({
			call: async (req, progress) => {
				progress({ kind: 'log', level: 'info', line: `[generic] ${req.url}: Downloading webpage` });
				return OK;
			}
		});
		const session = new ExtractSession(spawn, LOAD);
		const done = session.extract('  https://example.test/clip  ');
		expect(session.busy).toBe(true);
		await done;
		expect(client.call).toHaveBeenCalledWith({ url: 'https://example.test/clip' });
		expect(session.busy).toBe(false);
		expect(session.log).toEqual([
			{ level: 'info', line: '[generic] https://example.test/clip: Downloading webpage' }
		]);
		expect(session.result).toEqual(OK);
	});

	it('starts each extraction with a clean slate', async () => {
		const { spawn } = fakeEngine({
			call: async (_req, progress) => {
				progress({ kind: 'log', level: 'info', line: 'line' });
				return OK;
			}
		});
		const session = new ExtractSession(spawn, LOAD);
		await session.extract('https://example.test/1');
		await session.extract('https://example.test/2');
		expect(session.log).toHaveLength(1);
	});

	it('turns a crashed call into a failed result', async () => {
		const { spawn } = fakeEngine({
			call: async () => {
				throw new Error('worker terminated');
			}
		});
		const session = new ExtractSession(spawn, LOAD);
		await session.extract('https://example.test/');
		expect(session.result).toEqual({ ok: false, error: 'worker terminated', warnings: [] });
		expect(session.busy).toBe(false);
	});

	it('rejects input that is not a URL without calling the engine', async () => {
		const { spawn, client } = fakeEngine({});
		const session = new ExtractSession(spawn, LOAD);
		await session.extract('javascript:alert(1)');
		expect(session.inputError).toBeTruthy();
		expect(client.call).not.toHaveBeenCalled();
	});

	it('terminates the worker on dispose', async () => {
		const { spawn, client } = fakeEngine({});
		const session = new ExtractSession(spawn, LOAD);
		await session.boot();
		session.dispose();
		expect(client.terminate).toHaveBeenCalled();
	});
});

describe('normalizeInput', () => {
	it.each([
		['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
		['  www.youtube.com/watch?v=dQw4w9WgXcQ ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
		['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
		['http://example.test/a', 'http://example.test/a']
	])('accepts %j', (input, expected) => {
		expect(normalizeInput(input)).toBe(expected);
	});

	it.each(['', '   ', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'not a url'])(
		'rejects %j',
		(input) => {
			expect(normalizeInput(input)).toBeNull();
		}
	);
});
