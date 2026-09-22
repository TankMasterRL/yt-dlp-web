/** Origin gating, CORS and response hygiene shared by /relay and /solve. */
import { RelayHeader } from '../../src/lib/relay/protocol';

/** Chrome caps preflight caching at two hours. */
export const PREFLIGHT_MAX_AGE = 7200;

/** Headers that make any response inert if a browser ever renders it as a document. */
export const INERT_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
	'Content-Type': 'application/octet-stream',
	'Content-Security-Policy': "sandbox; default-src 'none'",
	'X-Content-Type-Options': 'nosniff',
	'Content-Disposition': 'attachment',
	'Cache-Control': 'no-store',
	'Referrer-Policy': 'no-referrer',
	'Cross-Origin-Resource-Policy': 'cross-origin'
};

export type Gate =
	| { ok: false; response: Response }
	| { ok: true; crossOrigin: boolean; cors: Record<string, string> };

/**
 * Admit same-origin callers, callers without an Origin (non-browser clients,
 * rate-limited like everyone else), and browsers on an allowed origin.
 */
export function gateOrigin(
	request: Request,
	allowedOrigins: ReadonlySet<string>,
	exposeHeaders: readonly string[]
): Gate {
	const origin = request.headers.get('Origin');
	const crossOrigin = origin !== null && origin !== new URL(request.url).origin;
	if (crossOrigin && !allowedOrigins.has(origin)) {
		return { ok: false, response: plainError(403, 'origin not allowed') };
	}
	const cors: Record<string, string> = crossOrigin
		? {
				'Access-Control-Allow-Origin': origin,
				'Access-Control-Expose-Headers': exposeHeaders.join(', '),
				Vary: 'Origin'
			}
		: { Vary: 'Origin' };
	return { ok: true, crossOrigin, cors };
}

export function preflight(
	gate: Extract<Gate, { ok: true }>,
	methods: readonly string[],
	allowHeaders: readonly string[]
): Response {
	if (!gate.crossOrigin) return plainError(400, 'not a CORS preflight', gate.cors);
	return new Response(null, {
		status: 204,
		headers: {
			...gate.cors,
			'Access-Control-Allow-Methods': methods.join(', '),
			'Access-Control-Allow-Headers': allowHeaders.join(', '),
			'Access-Control-Max-Age': String(PREFLIGHT_MAX_AGE)
		}
	});
}

/** Rate-limit key: Cloudflare's view of the client IP (cannot be spoofed through the edge). */
export function clientKey(request: Request): string {
	return request.headers.get('CF-Connecting-IP') ?? 'local';
}

const MAX_HEADER_REASON = 512;

/**
 * A reason fit for a header value: one line, Latin-1 only, bounded. Runtime
 * error messages (workerd's include a stack) routinely contain CR/LF, which
 * makes `new Response()` throw — turning a meaningful 4xx into a bare 500.
 */
export function headerSafe(reason: string): string {
	return reason
		.replace(/[\u0000-\u001f\u007f]+/g, ' ')
		.replace(/[^\u0020-\u00ff]/g, '?')
		.replace(/ {2,}/g, ' ')
		.trim()
		.slice(0, MAX_HEADER_REASON);
}

export function plainError(status: number, reason: string, extra: Record<string, string> = {}): Response {
	return new Response(reason, {
		status,
		headers: {
			...INERT_RESPONSE_HEADERS,
			'Content-Type': 'text/plain; charset=utf-8',
			...extra,
			[RelayHeader.error]: headerSafe(reason)
		}
	});
}

export async function readCapped(
	stream: ReadableStream<Uint8Array> | null,
	cap: number
): Promise<{ bytes: Uint8Array<ArrayBuffer>; truncated: boolean }> {
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
