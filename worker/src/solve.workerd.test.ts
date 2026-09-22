// @vitest-environment node
/**
 * /solve in the REAL workerd runtime (via Wrangler's test harness, which boots
 * the Worker from wrangler.jsonc with its Worker Loader binding). Unit tests
 * fake the loader; these prove the walls the sandbox actually relies on.
 */
import { createTestHarness } from 'wrangler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHeader } from '../../src/lib/relay/protocol';

type Harness = ReturnType<typeof createTestHarness>;
let server: Harness;

beforeAll(async () => {
	server = createTestHarness({ workers: [{ configPath: 'worker/wrangler.jsonc' }] });
	await server.listen();
}, 120_000);

afterAll(async () => {
	await server?.close();
});

const solve = (program: string) =>
	server.fetch('/solve', { method: 'POST', headers: { [RelayHeader.solve]: '1' }, body: program });

describe('/solve sandbox in workerd', () => {
	it('advertises that it can solve', async () => {
		expect((await server.fetch('/solve')).status).toBe(204);
	});

	it("runs a program written like yt-dlp-ejs's and returns what it printed", async () => {
		const res = await solve(
			'var lib = { twice: (x) => x * 2 }; Object.assign(globalThis, lib);' +
				'console.log(JSON.stringify({ type: "result", data: twice(21) }));'
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ type: 'result', data: 42 });
	});

	it('refuses network I/O from the program body', async () => {
		const res = await solve('const r = await fetch("https://example.com/"); console.log("LEAKED", r.status);');
		expect(res.status).toBe(422);
		expect(await res.text()).not.toContain('LEAKED');
	});

	it('blocks the network even from code smuggled into handler context', async () => {
		// Hijack Response, which main.js calls inside the fetch handler: there only
		// globalOutbound: null stands between the program and the internet.
		const res = await solve(`const Real = globalThis.Response;
globalThis.Response = function () {
	return fetch('https://example.com/').then(
		(r) => new Real('LEAKED ' + r.status),
		(e) => new Real('BLOCKED: ' + e.message)
	);
};`);
		const body = await res.text();
		expect(body).toMatch(/^BLOCKED: .*not permitted to access the internet/);
		expect(body).not.toContain('LEAKED');
	});

	it('exposes none of the outer Worker bindings', async () => {
		const res = await solve(
			'console.log(JSON.stringify(Object.keys(globalThis).filter((k) => /LOADER|RATE|ASSETS|ALLOWED/.test(k))))'
		);
		expect(await res.json()).toEqual([]);
	});

	it('reports a program that throws as a clean 422', async () => {
		const res = await solve('throw new Error("player changed");');
		expect(res.status).toBe(422);
		expect(res.headers.get(RelayHeader.error)).toBe('solver program failed: player changed');
	});
});
