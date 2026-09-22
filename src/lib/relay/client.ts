/**
 * Browser-side relay clients. Wire protocol: ./protocol.ts.
 *
 * - `createSyncTransport` — synchronous XHR for yt-dlp's RequestHandler, run in
 *   the engine worker (sync XHR with an ArrayBuffer response is only legal in a
 *   Worker, never on the main thread).
 * - `relayFetch` — streaming fetch for bulk media in the download worker.
 */
import type { SyncTransport } from '$lib/engine/transport';
import {
	RELAY_PATH,
	RelayHeader,
	SOLVE_PATH,
	decodeHeaderList,
	encodeHeaderJson,
	type HeaderList
} from './protocol';

/** One solve parses a multi-megabyte player; allow for a slow network, too. */
const SOLVE_TIMEOUT_MS = 60_000;

/** The relay refused the request or could not be reached — no upstream response exists. */
export class RelayError extends Error {
	override name = 'RelayError';
}

/** `/relay` on this origin (all-in-one deploy), or on the configured Worker. */
export function relayEndpoint(relayUrl: string | undefined): string {
	return relayUrl ? `${relayUrl.replace(/\/+$/, '')}${RELAY_PATH}` : RELAY_PATH;
}

/** `/solve` next to the relay. */
export function solveEndpoint(relayUrl: string | undefined): string {
	return relayUrl ? `${relayUrl.replace(/\/+$/, '')}${SOLVE_PATH}` : SOLVE_PATH;
}

/**
 * Synchronous solver for SandboxJCP: POST the program, return what it printed.
 * The X-Solve marker makes every cross-origin call preflight, so the Worker's
 * origin allowlist applies before it reads the program.
 */
export function createSyncSolver(
	endpoint: string,
	Xhr: typeof XMLHttpRequest = XMLHttpRequest
): (program: string) => string {
	return (program) => {
		const xhr = new Xhr();
		xhr.open('POST', endpoint, false);
		xhr.timeout = SOLVE_TIMEOUT_MS;
		xhr.setRequestHeader(RelayHeader.solve, '1');
		xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
		try {
			xhr.send(program);
		} catch (e) {
			throw new RelayError(`solver unreachable: ${(e as Error).message}`);
		}
		if (xhr.status !== 200) throw refusal(xhr.status, xhr.getResponseHeader(RelayHeader.error));
		return xhr.responseText;
	};
}

/** Can this deployment solve? A GET answers 204 or 501; errors count as "no". */
export async function probeSolver(endpoint: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
	try {
		const response = await fetchImpl(endpoint, { credentials: 'omit', cache: 'no-store' });
		return response.status === 204;
	} catch {
		return false;
	}
}

export function createSyncTransport(
	endpoint: string,
	Xhr: typeof XMLHttpRequest = XMLHttpRequest
): SyncTransport {
	return (request) => {
		const xhr = new Xhr();
		xhr.open(request.method, endpoint, false);
		xhr.responseType = 'arraybuffer';
		xhr.timeout = request.timeoutMs;
		xhr.setRequestHeader(RelayHeader.url, request.url);
		if (request.headers.length) {
			xhr.setRequestHeader(RelayHeader.headers, encodeHeaderJson(request.headers));
		}
		if (request.maxBytes) xhr.setRequestHeader(RelayHeader.maxBytes, String(request.maxBytes));
		try {
			// A sync XHR body must be a view over a plain ArrayBuffer.
			xhr.send(request.body ? new Uint8Array(request.body) : null);
		} catch (e) {
			throw new RelayError(`relay unreachable: ${(e as Error).message}`);
		}
		const upstreamStatus = xhr.getResponseHeader(RelayHeader.status);
		if (upstreamStatus === null) throw refusal(xhr.status, xhr.getResponseHeader(RelayHeader.error));
		return {
			status: Number(upstreamStatus),
			headers: decodeHeaderList(xhr.getResponseHeader(RelayHeader.headers)),
			body: new Uint8Array((xhr.response as ArrayBuffer | null) ?? new ArrayBuffer(0)),
			truncated: xhr.getResponseHeader(RelayHeader.truncated) === '1'
		};
	};
}

export interface RelayFetchRequest {
	url: string;
	method?: 'GET' | 'HEAD';
	headers?: HeaderList;
	signal?: AbortSignal;
}

export interface RelayFetchResponse {
	status: number;
	headers: HeaderList;
	body: ReadableStream<Uint8Array> | null;
}

export async function relayFetch(
	endpoint: string,
	request: RelayFetchRequest,
	fetchImpl: typeof fetch = fetch
): Promise<RelayFetchResponse> {
	const headers = new Headers({ [RelayHeader.url]: request.url });
	if (request.headers?.length) headers.set(RelayHeader.headers, encodeHeaderJson(request.headers));
	let response: Response;
	try {
		response = await fetchImpl(endpoint, {
			method: request.method ?? 'GET',
			headers,
			signal: request.signal,
			// The relay never needs this origin's cookies; don't send them.
			credentials: 'omit',
			cache: 'no-store'
		});
	} catch (e) {
		if ((e as Error).name === 'AbortError') throw e;
		throw new RelayError(`relay unreachable: ${(e as Error).message}`);
	}
	const upstreamStatus = response.headers.get(RelayHeader.status);
	if (upstreamStatus === null) {
		await response.body?.cancel();
		throw refusal(response.status, response.headers.get(RelayHeader.error));
	}
	return {
		status: Number(upstreamStatus),
		headers: decodeHeaderList(response.headers.get(RelayHeader.headers)),
		body: response.body
	};
}

function refusal(status: number, reason: string | null): RelayError {
	return new RelayError(reason ? `relay refused (${status}): ${reason}` : `relay responded ${status}`);
}
