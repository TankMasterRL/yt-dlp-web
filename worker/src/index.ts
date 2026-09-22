/**
 * The yt-dlp-web Worker: a byte relay for yt-dlp running in the browser, and —
 * when deployed all-in-one — the static app itself. It holds no secrets, stores
 * nothing and parses nothing.
 */
import { RELAY_PATH } from '../../src/lib/relay/protocol';
import { relayConfig, type Env } from './config';
import { handleRelay, type RelayConfig } from './relay';

let cached: { env: Env; config: RelayConfig } | undefined;

function configFor(env: Env): RelayConfig {
	if (cached?.env !== env) cached = { env, config: relayConfig(env) };
	return cached.config;
}

export default {
	async fetch(request, env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === RELAY_PATH) {
			return handleRelay(request, configFor(env), {
				fetchUpstream: (url, init) => fetch(url, init),
				limiter: env.RATE_LIMITER
			});
		}
		// All-in-one deploy: everything else is the static app.
		if (env.ASSETS) return env.ASSETS.fetch(request);
		return new Response('Not found', { status: 404 });
	}
} satisfies ExportedHandler<Env>;
