// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { RelayHeader } from '../../src/lib/relay/protocol';
import type { SandboxCode } from './sandbox';
import { handleSolve, type SandboxLoader, type SolveConfig } from './solve';

const APP = 'https://app.example';
const config: SolveConfig = { allowedOrigins: new Set([APP]), maxProgramBytes: 1024, cpuMs: 5000 };
const PROGRAM = 'console.log(JSON.stringify({type:"result",responses:[]}))';

function fakeLoader(run: (code: SandboxCode) => Promise<Response> = async () => new Response('{"type":"result"}')) {
	const load = vi.fn((code: SandboxCode) => ({ getEntrypoint: () => ({ fetch: () => run(code) }) }));
	return { load } satisfies SandboxLoader;
}

function solve(init: RequestInit & { headers?: Record<string, string> }, loader?: SandboxLoader, limiter?: never) {
	return handleSolve(new Request('https://relay.example/solve', init), config, { loader, limiter });
}

const post = (body: string, headers: Record<string, string> = {}): RequestInit => ({
	method: 'POST',
	body,
	headers: { [RelayHeader.solve]: '1', 'Content-Type': 'text/plain', ...headers }
});

describe('/solve', () => {
	it('advertises availability: 204 with a loader, 501 without', async () => {
		expect((await solve({ method: 'GET' }, fakeLoader())).status).toBe(204);
		const res = await solve({ method: 'GET' });
		expect(res.status).toBe(501);
		expect(res.headers.get(RelayHeader.error)).toMatch(/worker_loaders/);
	});

	it('runs the program in a network-severed isolate and returns its output', async () => {
		const loader = fakeLoader();
		const res = await solve(post(PROGRAM), loader);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('{"type":"result"}');
		const code = loader.load.mock.calls[0][0];
		expect(code.globalOutbound).toBeNull();
		expect(code.env).toEqual({});
		expect(code.limits).toEqual({ cpuMs: 5000, subRequests: 0 });
		expect(code.modules['program.js']).toBe(PROGRAM);
	});

	it('serves output that can never render as a document', async () => {
		const res = await solve(post(PROGRAM), fakeLoader());
		expect(res.headers.get('Content-Security-Policy')).toMatch(/sandbox/);
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
	});

	it('reports a failing program as 422', async () => {
		const loader = fakeLoader(async () => {
			throw new Error('ReferenceError: nFunction is not defined');
		});
		const res = await solve(post(PROGRAM), loader);
		expect(res.status).toBe(422);
		expect(res.headers.get(RelayHeader.error)).toMatch(/nFunction is not defined/);
	});

	it('requires the X-Solve marker, so a drive-by form post cannot reach the solver', async () => {
		const loader = fakeLoader();
		const res = await solve({ method: 'POST', body: PROGRAM, headers: { 'Content-Type': 'text/plain' } }, loader);
		expect(res.status).toBe(400);
		expect(loader.load).not.toHaveBeenCalled();
	});

	it('refuses oversized programs, foreign origins and other methods', async () => {
		const loader = fakeLoader();
		expect((await solve(post('x'.repeat(2048)), loader)).status).toBe(413);
		expect((await solve(post(PROGRAM, { Origin: 'https://evil.example' }), loader)).status).toBe(403);
		expect((await solve({ method: 'PUT', body: PROGRAM }, loader)).status).toBe(405);
		expect(loader.load).not.toHaveBeenCalled();
	});

	it('answers preflights from allowed origins', async () => {
		const res = await solve(
			{ method: 'OPTIONS', headers: { Origin: APP, 'Access-Control-Request-Method': 'POST' } },
			fakeLoader()
		);
		expect(res.status).toBe(204);
		expect(res.headers.get('Access-Control-Allow-Headers')).toContain(RelayHeader.solve);
	});

	it('rate-limits per client', async () => {
		const limiter = { limit: vi.fn(async () => ({ success: false })) };
		const res = await handleSolve(new Request('https://relay.example/solve', post(PROGRAM)), config, {
			loader: fakeLoader(),
			limiter
		});
		expect(res.status).toBe(429);
	});
});
