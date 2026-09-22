/**
 * The yt-dlp-web Worker: a byte relay for yt-dlp running in the browser, a
 * sandbox for YouTube's JS challenges, and — when deployed all-in-one — the
 * static app itself. It holds no secrets, stores nothing and parses nothing.
 */
import { RELAY_PATH, SOLVE_PATH } from '../../src/lib/relay/protocol';
import { relayConfig, solveConfig, type Env } from './config';
import { handleRelay, type RelayConfig } from './relay';
import { handleSolve, type SandboxLoader, type SolveConfig } from './solve';

let cached: { env: Env; relay: RelayConfig; solve: SolveConfig } | undefined;

function configFor(env: Env) {
	if (cached?.env !== env) cached = { env, relay: relayConfig(env), solve: solveConfig(env) };
	return cached;
}

export default {
	async fetch(request, env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === RELAY_PATH) {
			return handleRelay(request, configFor(env).relay, {
				fetchUpstream: (url, init) => fetch(url, init),
				limiter: env.RATE_LIMITER
			});
		}
		if (pathname === SOLVE_PATH) {
			return handleSolve(request, configFor(env).solve, {
				loader: env.LOADER as SandboxLoader | undefined,
				limiter: env.RATE_LIMITER
			});
		}
		// All-in-one deploy: everything else is the static app.
		if (env.ASSETS) return env.ASSETS.fetch(request);
		return new Response('Not found', { status: 404 });
	}
} satisfies ExportedHandler<Env>;
