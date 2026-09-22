import { parseHostPatterns } from './policy';
import type { RelayConfig } from './relay';

export interface Env {
	/** Comma-separated host patterns the relay may fetch (`a.com, *.b.com`). */
	ALLOWED_HOSTS?: string;
	/** Comma-separated origins, besides the Worker's own, that browsers may call it from. */
	ALLOWED_ORIGINS?: string;
	MAX_REQUEST_BODY_BYTES?: string;
	MAX_BUFFERED_BYTES?: string;
	/** Workers Rate Limiting binding (`ratelimits` in wrangler.jsonc). */
	RATE_LIMITER?: RateLimit;
	/** Dynamic Worker Loader binding for /solve (`worker_loaders`). Paid plans only. */
	LOADER?: WorkerLoader;
	/** Static assets: set when this Worker also serves the app (all-in-one deploy). */
	ASSETS?: Fetcher;
}

/**
 * Every host yt-dlp's YouTube extractor talks to: pages and the innertube API,
 * short links, the nocookie embed domain, media, thumbnails and avatars.
 */
export const DEFAULT_ALLOWED_HOSTS = [
	'youtube.com',
	'*.youtube.com',
	'youtu.be',
	'*.youtube-nocookie.com',
	'youtubei.googleapis.com',
	'*.googlevideo.com',
	'*.ytimg.com',
	'*.ggpht.com'
].join(', ');

export function relayConfig(env: Env): RelayConfig {
	return {
		allowedHosts: parseHostPatterns(env.ALLOWED_HOSTS ?? DEFAULT_ALLOWED_HOSTS),
		allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS ?? ''),
		maxRequestBodyBytes: positiveInt(env.MAX_REQUEST_BODY_BYTES, 1 << 20),
		maxBufferedBytes: positiveInt(env.MAX_BUFFERED_BYTES, 32 << 20)
	};
}

/** Exact origins only: no wildcard, no "null", no paths. */
export function parseOrigins(spec: string): Set<string> {
	const origins = new Set<string>();
	for (const raw of spec.split(',')) {
		const origin = raw.trim();
		if (!origin) continue;
		if (origin === '*' || origin === 'null') {
			throw new Error(`Refusing to allow origin "${origin}"`);
		}
		if (new URL(origin).origin !== origin) {
			throw new Error(`"${origin}" is not a bare origin (scheme://host[:port], no trailing slash)`);
		}
		origins.add(origin);
	}
	return origins;
}

function positiveInt(value: string | undefined, fallback: number): number {
	if (value === undefined || value === '') return fallback;
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) throw new Error(`Expected a positive integer, got "${value}"`);
	return n;
}
