/**
 * /solve — run a YouTube JS-challenge solver program in a sandboxed isolate.
 *
 * The browser's SandboxJCP (src/python/ytdlp_web/solver_jcp.py) POSTs the exact
 * program yt-dlp's EJS providers would pipe to Deno; this handler evaluates it
 * via the Worker Loader binding in an isolate with no network, no bindings and a
 * CPU budget (./sandbox.ts), and returns what it printed. It fetches nothing
 * itself: the player source arrives inside the program.
 */
import { RelayHeader } from '../../src/lib/relay/protocol';
import { INERT_RESPONSE_HEADERS, clientKey, gateOrigin, plainError, preflight, readCapped } from './http';
import type { RateLimiter } from './relay';
import { sandboxCode, type SandboxCode } from './sandbox';

export interface SolveConfig {
	allowedOrigins: ReadonlySet<string>;
	/** The program carries the whole player script (a few MB). */
	maxProgramBytes: number;
	cpuMs: number;
}

/** The slice of the Worker Loader binding /solve uses. */
export interface SandboxLoader {
	load(code: SandboxCode): { getEntrypoint(): { fetch(input: string): Promise<Response> } };
}

export interface SolveDeps {
	loader?: SandboxLoader;
	limiter?: RateLimiter;
}

const UNAVAILABLE =
	'JS challenge solving is not available on this deployment: it needs a Worker Loader binding ' +
	'(worker_loaders, Workers Paid plan)';

export async function handleSolve(request: Request, config: SolveConfig, deps: SolveDeps): Promise<Response> {
	const gate = gateOrigin(request, config.allowedOrigins, [RelayHeader.error]);
	if (!gate.ok) return gate.response;
	const fail = (status: number, reason: string) => plainError(status, reason, gate.cors);

	switch (request.method) {
		case 'OPTIONS':
			return preflight(gate, ['GET', 'POST'], [RelayHeader.solve, 'Content-Type']);
		case 'GET':
			return deps.loader
				? new Response(null, { status: 204, headers: { ...gate.cors, 'Cache-Control': 'no-store' } })
				: fail(501, UNAVAILABLE);
		case 'POST':
			break;
		default:
			return fail(405, `method ${request.method} not supported`);
	}

	// A custom header makes every cross-origin call preflight, so the origin
	// allowlist is enforced before a byte of the program is read.
	if (!request.headers.get(RelayHeader.solve)) return fail(400, `missing ${RelayHeader.solve}`);
	if (!deps.loader) return fail(501, UNAVAILABLE);
	if (deps.limiter && !(await deps.limiter.limit({ key: clientKey(request) })).success) {
		return fail(429, 'rate limit exceeded');
	}

	const read = await readCapped(request.body, config.maxProgramBytes);
	if (read.truncated) return fail(413, 'program too large');
	const program = new TextDecoder().decode(read.bytes);

	let output: string;
	try {
		const sandbox = deps.loader.load(sandboxCode(program, config.cpuMs));
		const response = await sandbox.getEntrypoint().fetch('https://sandbox.invalid/');
		output = await response.text();
		if (!response.ok) return fail(422, `solver program failed: HTTP ${response.status}`);
	} catch (e) {
		return fail(422, `solver program failed: ${(e as Error).message}`);
	}
	return new Response(output, {
		headers: { ...INERT_RESPONSE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...gate.cors }
	});
}
