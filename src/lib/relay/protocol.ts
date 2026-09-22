/**
 * The relay wire protocol, shared by the Worker (worker/src/relay.ts) and the
 * browser clients (src/lib/relay/client.ts). One relay request = exactly one
 * upstream request:
 *
 *   {GET|HEAD|POST} /relay
 *     X-Relay-Url:       absolute upstream URL (a header, not a query string, so the
 *                        relay URL is constant and CORS preflights stay cached)
 *     X-Relay-Headers:   JSON [[name, value], …] — upstream request headers,
 *                        including ones XHR may not set (Cookie, Referer, Origin)
 *     X-Relay-Max-Bytes: optional cap; the relay buffers at most this much body
 *
 *   ← HTTP status = upstream status, except 3xx → 200 (a browser would follow a
 *     real 3xx itself, straight into a CORS failure)
 *     X-Relay-Status:    upstream status
 *     X-Relay-Headers:   JSON [[name, value], …] — upstream response headers,
 *                        Set-Cookie included (JS can never read a real one)
 *     X-Relay-Truncated: "1" when the body was cut at X-Relay-Max-Bytes
 *     body:              upstream body, always served as application/octet-stream
 *
 * The relay never follows redirects: every hop is a new relay request, so every
 * hop passes the same allowlist check.
 */
export const RELAY_PATH = '/relay';

/**
 * YouTube's JS challenges: POST the solver program (text) → its stdout (text).
 * GET answers 204 when this deployment can solve (worker_loader bound), 501 when not.
 */
export const SOLVE_PATH = '/solve';

export const RelayHeader = {
	url: 'X-Relay-Url',
	headers: 'X-Relay-Headers',
	maxBytes: 'X-Relay-Max-Bytes',
	status: 'X-Relay-Status',
	truncated: 'X-Relay-Truncated',
	error: 'X-Relay-Error',
	/** Required on POST /solve: forces a CORS preflight, so no page can drive-by the solver. */
	solve: 'X-Solve'
} as const;

export type HeaderList = [string, string][];

/**
 * JSON safe to carry in an HTTP header: header values must be ByteStrings, so
 * everything outside printable ASCII is \u-escaped.
 */
export function encodeHeaderJson(value: unknown): string {
	return JSON.stringify(value).replace(
		/[\u0000-\u001f\u007f-￿]/g,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
	);
}

/** Parse a header list, rejecting anything that is not [[string, string], …]. */
export function decodeHeaderList(value: string | null): HeaderList {
	if (!value) return [];
	const parsed: unknown = JSON.parse(value);
	if (
		!Array.isArray(parsed) ||
		!parsed.every(
			(pair) =>
				Array.isArray(pair) &&
				pair.length === 2 &&
				typeof pair[0] === 'string' &&
				typeof pair[1] === 'string'
		)
	) {
		throw new TypeError('expected a JSON list of [name, value] string pairs');
	}
	return parsed as HeaderList;
}
