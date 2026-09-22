/**
 * The byte relay: one browser request → exactly one upstream request.
 * Wire protocol: src/lib/relay/protocol.ts. Upstream fetch and rate limiter are
 * injected, so the same handler runs in the Worker, in the e2e fixture relay
 * (scripts/fixture-relay.ts) and in unit tests.
 */
import {
	RelayHeader,
	decodeHeaderList,
	encodeHeaderJson,
	type HeaderList
} from '../../src/lib/relay/protocol';
import { checkTarget, type HostPattern } from './policy';

export interface RelayConfig {
	allowedHosts: readonly HostPattern[];
	/** Origins other than the relay's own that browsers may call it from. */
	allowedOrigins: ReadonlySet<string>;
	maxRequestBodyBytes: number;
	/** Ceiling for X-Relay-Max-Bytes: the most the relay will ever buffer. */
	maxBufferedBytes: number;
}

export interface RateLimiter {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RelayDeps {
	fetchUpstream: (url: string, init: RequestInit & { redirect: 'manual' }) => Promise<Response>;
	limiter?: RateLimiter;
}

const METHODS = new Set(['GET', 'HEAD', 'POST']);
/** Chrome caps preflight caching at two hours. */
const PREFLIGHT_MAX_AGE = 7200;
const ALLOW_HEADERS = [RelayHeader.url, RelayHeader.headers, RelayHeader.maxBytes, 'Content-Type'];
const EXPOSE_HEADERS = [RelayHeader.status, RelayHeader.headers, RelayHeader.truncated, RelayHeader.error];

/** Never forwarded upstream: hop-by-hop, routing, and client-identity headers. */
const DROPPED_REQUEST_HEADERS = new Set([
	'host',
	'connection',
	'keep-alive',
	'proxy-connection',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'content-length',
	'accept-encoding',
	'forwarded',
	'via',
	'x-real-ip',
	'true-client-ip'
]);
const DROPPED_REQUEST_PREFIXES = ['cf-', 'x-forwarded-'];
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade'
]);
/** Browser navigations and embeds can never be relay requests. */
const DOCUMENT_DESTINATIONS = new Set(['document', 'iframe', 'frame', 'embed', 'object']);

/** Headers that make any relay response inert if a browser ever renders it. */
const INERT_RESPONSE_HEADERS = {
	'Content-Type': 'application/octet-stream',
	'Content-Security-Policy': "sandbox; default-src 'none'",
	'X-Content-Type-Options': 'nosniff',
	'Content-Disposition': 'attachment',
	'Cache-Control': 'no-store',
	'Referrer-Policy': 'no-referrer',
	'Cross-Origin-Resource-Policy': 'cross-origin'
};

export async function handleRelay(
	request: Request,
	config: RelayConfig,
	deps: RelayDeps
): Promise<Response> {
	const origin = request.headers.get('Origin');
	const selfOrigin = new URL(request.url).origin;
	const crossOrigin = origin !== null && origin !== selfOrigin;
	if (crossOrigin && !config.allowedOrigins.has(origin)) {
		return plainError(403, 'origin not allowed');
	}
	const cors: Record<string, string> = crossOrigin
		? {
				'Access-Control-Allow-Origin': origin,
				'Access-Control-Expose-Headers': EXPOSE_HEADERS.join(', '),
				Vary: 'Origin'
			}
		: { Vary: 'Origin' };
	const fail = (status: number, reason: string) => plainError(status, reason, cors);

	if (request.method === 'OPTIONS') {
		if (!crossOrigin) return fail(400, 'not a CORS preflight');
		return new Response(null, {
			status: 204,
			headers: {
				...cors,
				'Access-Control-Allow-Methods': [...METHODS].join(', '),
				'Access-Control-Allow-Headers': ALLOW_HEADERS.join(', '),
				'Access-Control-Max-Age': String(PREFLIGHT_MAX_AGE)
			}
		});
	}
	if (!METHODS.has(request.method)) return fail(405, `method ${request.method} not relayed`);

	if (
		request.headers.get('Sec-Fetch-Mode') === 'navigate' ||
		DOCUMENT_DESTINATIONS.has(request.headers.get('Sec-Fetch-Dest') ?? '')
	) {
		return fail(403, 'navigations are not relayed');
	}

	const target = request.headers.get(RelayHeader.url);
	if (!target) return fail(400, `missing ${RelayHeader.url}`);
	const check = checkTarget(target, config.allowedHosts);
	if (!check.ok) return fail(403, check.reason);

	if (deps.limiter) {
		const key = request.headers.get('CF-Connecting-IP') ?? 'local';
		if (!(await deps.limiter.limit({ key })).success) return fail(429, 'rate limit exceeded');
	}

	let tunnelled: HeaderList;
	try {
		tunnelled = decodeHeaderList(request.headers.get(RelayHeader.headers));
	} catch (e) {
		return fail(400, `bad ${RelayHeader.headers}: ${(e as Error).message}`);
	}
	const upstreamHeaders = new Headers();
	for (const [name, value] of tunnelled) {
		const lower = name.toLowerCase();
		if (DROPPED_REQUEST_HEADERS.has(lower)) continue;
		if (DROPPED_REQUEST_PREFIXES.some((p) => lower.startsWith(p))) continue;
		upstreamHeaders.append(name, value);
	}

	let body: ArrayBuffer | undefined;
	if (request.method === 'POST' && request.body) {
		const read = await readCapped(request.body, config.maxRequestBodyBytes);
		if (read.truncated) return fail(413, 'request body too large');
		body = read.bytes.buffer as ArrayBuffer;
	}

	let upstream: Response;
	try {
		upstream = await deps.fetchUpstream(check.url.href, {
			method: request.method,
			headers: upstreamHeaders,
			body,
			redirect: 'manual'
		});
	} catch (e) {
		return fail(502, `upstream unreachable: ${(e as Error).message}`);
	}

	const headers: Record<string, string> = {
		...INERT_RESPONSE_HEADERS,
		...cors,
		[RelayHeader.status]: String(upstream.status),
		[RelayHeader.headers]: encodeHeaderJson(tunnelResponseHeaders(upstream.headers))
	};
	// A real 3xx would make the browser follow it straight into a CORS failure.
	const status = upstream.status >= 300 && upstream.status < 400 ? 200 : upstream.status;
	const bodyless = request.method === 'HEAD' || [204, 205, 304].includes(status);

	const requestedCap = Number(request.headers.get(RelayHeader.maxBytes));
	if (!bodyless && Number.isFinite(requestedCap) && requestedCap > 0) {
		const read = await readCapped(upstream.body, Math.min(requestedCap, config.maxBufferedBytes));
		if (read.truncated) headers[RelayHeader.truncated] = '1';
		return new Response(read.bytes, { status, headers });
	}
	return new Response(bodyless ? null : upstream.body, { status, headers });
}

/** Upstream response headers as data. The runtime already decoded any Content-Encoding. */
function tunnelResponseHeaders(source: Headers): HeaderList {
	const decoded = source.has('content-encoding');
	const list: HeaderList = [];
	for (const [name, value] of source) {
		const lower = name.toLowerCase();
		if (lower === 'set-cookie' || HOP_BY_HOP_RESPONSE_HEADERS.has(lower)) continue;
		if (decoded && (lower === 'content-encoding' || lower === 'content-length')) continue;
		list.push([lower, value]);
	}
	for (const cookie of source.getSetCookie()) list.push(['set-cookie', cookie]);
	return list;
}

async function readCapped(
	stream: ReadableStream<Uint8Array> | null,
	cap: number
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (!stream) return { bytes: new Uint8Array(), truncated: false };
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (total + value.byteLength > cap) {
			chunks.push(value.subarray(0, cap - total));
			total = cap;
			truncated = true;
			await reader.cancel();
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated };
}

function plainError(status: number, reason: string, extra: Record<string, string> = {}): Response {
	return new Response(reason, {
		status,
		headers: {
			...INERT_RESPONSE_HEADERS,
			'Content-Type': 'text/plain; charset=utf-8',
			...extra,
			[RelayHeader.error]: reason
		}
	});
}
