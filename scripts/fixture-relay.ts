/**
 * The REAL relay handler (worker/src/relay.ts) served by Bun, with the fake
 * video site in tests/fixtures/site.ts as its upstream. Playwright starts it
 * next to `vite preview`, so e2e exercises the true relay protocol, CORS
 * preflights and policy checks — only the internet is swapped out.
 */
import { FIXTURE_HOSTS, fixtureFetch } from '../tests/fixtures/site.ts';
import { parseHostPatterns } from '../worker/src/policy.ts';
import { handleRelay, type RelayConfig } from '../worker/src/relay.ts';

const port = Number(process.env.FIXTURE_RELAY_PORT ?? 4174);
const config: RelayConfig = {
	allowedHosts: parseHostPatterns(FIXTURE_HOSTS),
	allowedOrigins: new Set((process.env.FIXTURE_ALLOWED_ORIGINS ?? 'http://localhost:4173').split(',')),
	maxRequestBodyBytes: 1 << 20,
	maxBufferedBytes: 32 << 20
};

Bun.serve({
	port,
	fetch: (request) => handleRelay(request, config, { fetchUpstream: fixtureFetch })
});
console.log(`fixture relay listening on http://localhost:${port}`);
