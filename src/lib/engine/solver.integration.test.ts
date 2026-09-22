// @vitest-environment node
/**
 * YouTube JS-challenge solving through SandboxJCP, end to end minus YouTube:
 * real Pyodide + pinned wheels, yt-dlp's own challenge director choosing our
 * provider, the player downloaded through the transport, and the REAL yt-dlp-ejs
 * lib + core scripts executed through the Worker's sandbox module wrapper in a
 * real V8 (tests/helpers/sandbox-runner.ts). Solving a real player is covered by
 * the @live e2e test; here the player is a stand-in.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPyodide } from 'pyodide';
import { beforeAll, describe, expect, it } from 'vitest';
import { runInSandboxModules } from '../../../tests/helpers/sandbox-runner';
import { bootEngine, type Engine } from './runtime';
import type { TransportRequest } from './transport';
import { WHEELS } from './wheels';

const cacheDir = join(process.cwd(), '.wheel-cache');
const wheelsPresent = WHEELS.every((w) => existsSync(join(cacheDir, w.file)));

const PLAYER_URL = 'https://www.youtube.com/s/player/0123abcd/player_ias.vflset/en_US/base.js';
const FAKE_PLAYER = 'var yt = { player: "stand-in" };';

/** Python run inside Pyodide: ask yt-dlp's JSC director to solve one n challenge. */
const SOLVE_N = `
import yt_dlp
from yt_dlp.extractor.youtube.jsc.provider import JsChallengeRequest, JsChallengeType, NChallengeInput

ydl = yt_dlp.YoutubeDL({'quiet': True, 'js_runtimes': {}, 'remote_components': []})
ie = ydl.get_info_extractor('Youtube')
ie.initialize()
director = ie._jsc_director
available = sorted(k for k, p in director.providers.items() if p.is_available())
request = JsChallengeRequest(
    type=JsChallengeType.N,
    input=NChallengeInput(player_url=${JSON.stringify(PLAYER_URL)}, challenges=['abcdefgh']),
    video_id='dQw4w9WgXcQ')
results = {r.type.value: dict(resp.output.results) for r, resp in director.bulk_solve([request])}
ydl.close()
import json
json.dumps({'available': available, 'results': results})
`;

describe.skipIf(!wheelsPresent)('YouTube JS challenges through SandboxJCP', () => {
	let engine: Engine;
	const programs: string[] = [];
	let respond: (program: string) => string;
	const fetched: TransportRequest[] = [];

	beforeAll(async () => {
		engine = await bootEngine({
			loadPyodide: () => loadPyodide(),
			readWheel: async (pin) => readFile(join(cacheDir, pin.file)),
			transport: (req) => {
				fetched.push(req);
				if (req.url === PLAYER_URL) {
					return {
						status: 200,
						headers: [['content-type', 'text/javascript']],
						body: new TextEncoder().encode(FAKE_PLAYER),
						truncated: false
					};
				}
				throw new Error(`unexpected request ${req.url}`);
			},
			solver: (program) => {
				programs.push(program);
				return respond(program);
			}
		});
	});

	const solveN = () => JSON.parse(engine.pyodide.runPython(SOLVE_N)) as {
		available: string[];
		results: Record<string, Record<string, string>>;
	};

	it("is the only available provider, so yt-dlp's director picks it", () => {
		respond = () => JSON.stringify({ type: 'result', responses: [{ type: 'result', data: { abcdefgh: 'SOLVED-n' } }] });
		expect(solveN().available).toEqual(['Sandbox']);
	});

	it('downloads the player through the transport and ships the real EJS solver with it', () => {
		programs.length = 0;
		fetched.length = 0;
		respond = () => JSON.stringify({ type: 'result', responses: [{ type: 'result', data: { abcdefgh: 'SOLVED-n' } }] });
		solveN();
		expect(fetched.map((r) => r.url)).toContain(PLAYER_URL);
		expect(programs).toHaveLength(1);
		const [program] = programs;
		// Exactly what yt-dlp's EJS providers pipe to Deno: lib, core, then the call.
		expect(program).toContain('Object.assign(globalThis, lib);');
		expect(program).toContain(JSON.stringify(FAKE_PLAYER).slice(1, -1));
		expect(program).toMatch(/console\.log\(JSON\.stringify\(jsc\(/);
		expect(program.length).toBeGreaterThan(100_000); // the bundled solver scripts
	});

	it('hands valid solver output back to yt-dlp as solved challenges', () => {
		respond = () => JSON.stringify({ type: 'result', responses: [{ type: 'result', data: { abcdefgh: 'SOLVED-n' } }] });
		expect(solveN().results).toEqual({ n: { abcdefgh: 'SOLVED-n' } });
	});

	it('runs the real EJS scripts in the sandbox wrapper; yt-dlp treats a rejected player as unsolved', () => {
		respond = runInSandboxModules;
		expect(solveN().results).toEqual({});
		// The real solver loaded as ES modules — lib's bundled parser, core's jsc() —
		// and examined the player: rejecting a stand-in's structure is ITS verdict,
		// not a SyntaxError or ReferenceError from our wrapper. (Deno would exit
		// non-zero the same way; yt-dlp handles both as an unsolved challenge.)
		expect(() => runInSandboxModules(programs.at(-1)!)).toThrow(/unexpected structure/);
	});

	it('degrades to unsolved when the sandbox fails', () => {
		respond = () => {
			throw new Error('relay refused (501): no Worker Loader binding');
		};
		expect(solveN().results).toEqual({});
	});
});
