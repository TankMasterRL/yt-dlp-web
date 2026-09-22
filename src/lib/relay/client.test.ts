// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { TransportRequest } from '$lib/engine/transport';
import { RelayError, createSyncTransport, relayEndpoint, relayFetch } from './client';
import { RelayHeader, decodeHeaderList, encodeHeaderJson } from './protocol';

/** A scriptable stand-in for XMLHttpRequest, recording what the transport did. */
class FakeXhr {
	static respond: (xhr: FakeXhr) => void = () => {};
	static instances: FakeXhr[] = [];
	method = '';
	url = '';
	async?: boolean;
	responseType = '';
	timeout = 0;
	requestHeaders: Record<string, string> = {};
	sent: unknown;
	status = 0;
	response: ArrayBuffer | null = null;
	responseHeaders: Record<string, string> = {};
	constructor() {
		FakeXhr.instances.push(this);
	}
	open(method: string, url: string, async: boolean) {
		Object.assign(this, { method, url, async });
	}
	setRequestHeader(name: string, value: string) {
		this.requestHeaders[name] = value;
	}
	send(body: unknown) {
		this.sent = body;
		FakeXhr.respond(this);
	}
	getResponseHeader(name: string) {
		return this.responseHeaders[name] ?? null;
	}
}

function fakeXhr(respond: (xhr: FakeXhr) => void) {
	FakeXhr.respond = respond;
	FakeXhr.instances = [];
	return { Xhr: FakeXhr as unknown as typeof XMLHttpRequest, instances: FakeXhr.instances };
}

const request: TransportRequest = {
	method: 'POST',
	url: 'https://www.youtube.com/youtubei/v1/player',
	headers: [
		['Cookie', 'SOCS=x'],
		['Content-Type', 'application/json']
	],
	body: new TextEncoder().encode('{"videoId":"x"}'),
	timeoutMs: 20000,
	maxBytes: 1024
};

describe('relayEndpoint', () => {
	it('is same-origin /relay when no relay URL is configured', () => {
		expect(relayEndpoint(undefined)).toBe('/relay');
	});
	it('appends /relay to a configured Worker URL', () => {
		expect(relayEndpoint('https://yt-dlp-web.example.workers.dev/')).toBe(
			'https://yt-dlp-web.example.workers.dev/relay'
		);
	});
});

describe('synchronous transport (engine worker)', () => {
	it('sends one synchronous, binary relay request carrying the upstream request', () => {
		const { Xhr, instances } = fakeXhr((xhr) => {
			xhr.status = 200;
			xhr.response = new TextEncoder().encode('{"ok":1}').buffer as ArrayBuffer;
			xhr.responseHeaders = {
				[RelayHeader.status]: '200',
				[RelayHeader.headers]: encodeHeaderJson([['set-cookie', 'a=1'], ['content-type', 'application/json']])
			};
		});
		const response = createSyncTransport('/relay', Xhr)(request);

		const xhr = instances[0];
		expect(xhr).toMatchObject({ method: 'POST', url: '/relay', async: false, responseType: 'arraybuffer' });
		expect(xhr.timeout).toBe(20000);
		expect(xhr.requestHeaders[RelayHeader.url]).toBe(request.url);
		expect(decodeHeaderList(xhr.requestHeaders[RelayHeader.headers])).toEqual(request.headers);
		expect(xhr.requestHeaders[RelayHeader.maxBytes]).toBe('1024');
		// A copy, not the original: a view into the WASM heap can be detached by memory.grow.
		expect(xhr.sent).toEqual(request.body);

		expect(response.status).toBe(200);
		expect(response.headers).toContainEqual(['set-cookie', 'a=1']);
		expect(new TextDecoder().decode(response.body)).toBe('{"ok":1}');
		expect(response.truncated).toBe(false);
	});

	it('reports the upstream status, not the relay status, for tunnelled redirects', () => {
		const { Xhr } = fakeXhr((xhr) => {
			xhr.status = 200;
			xhr.response = new ArrayBuffer(0);
			xhr.responseHeaders = {
				[RelayHeader.status]: '302',
				[RelayHeader.headers]: encodeHeaderJson([['location', 'https://youtu.be/x']])
			};
		});
		const response = createSyncTransport('/relay', Xhr)(request);
		expect(response.status).toBe(302);
		expect(response.headers).toContainEqual(['location', 'https://youtu.be/x']);
	});

	it('flags truncated bodies', () => {
		const { Xhr } = fakeXhr((xhr) => {
			xhr.status = 200;
			xhr.response = new ArrayBuffer(1024);
			xhr.responseHeaders = { [RelayHeader.status]: '200', [RelayHeader.truncated]: '1' };
		});
		expect(createSyncTransport('/relay', Xhr)(request).truncated).toBe(true);
	});

	it('throws RelayError when the relay itself refuses (no upstream status)', () => {
		const { Xhr } = fakeXhr((xhr) => {
			xhr.status = 403;
			xhr.responseHeaders = { [RelayHeader.error]: 'host not on the allowlist: evil.example' };
		});
		expect(() => createSyncTransport('/relay', Xhr)(request)).toThrow(RelayError);
		expect(() => createSyncTransport('/relay', Xhr)(request)).toThrow(/allowlist/);
	});

	it('throws RelayError on network failure', () => {
		const { Xhr } = fakeXhr(() => {
			throw new DOMException('Failed to execute send', 'NetworkError');
		});
		expect(() => createSyncTransport('/relay', Xhr)(request)).toThrow(/relay unreachable/);
	});
});

describe('relayFetch (download worker)', () => {
	it('streams through the relay with tunnelled headers', async () => {
		const fetchImpl = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response('0123456789', {
					status: 206,
					headers: {
						[RelayHeader.status]: '206',
						[RelayHeader.headers]: encodeHeaderJson([['content-range', 'bytes 0-9/100']])
					}
				})
		);
		const response = await relayFetch(
			'/relay',
			{ url: 'https://rr1.googlevideo.com/videoplayback', headers: [['Range', 'bytes=0-9']] },
			fetchImpl
		);
		const init = fetchImpl.mock.calls[0][1]!;
		expect(new Headers(init.headers).get(RelayHeader.url)).toBe('https://rr1.googlevideo.com/videoplayback');
		expect(decodeHeaderList(new Headers(init.headers).get(RelayHeader.headers))).toEqual([
			['Range', 'bytes=0-9']
		]);
		expect(init.credentials).toBe('omit');
		expect(response.status).toBe(206);
		expect(response.headers).toContainEqual(['content-range', 'bytes 0-9/100']);
		expect(await new Response(response.body).text()).toBe('0123456789');
	});

	it('throws RelayError when the relay refuses', async () => {
		const fetchImpl = async () =>
			new Response('no', { status: 429, headers: { [RelayHeader.error]: 'rate limit exceeded' } });
		await expect(relayFetch('/relay', { url: 'https://x.googlevideo.com/' }, fetchImpl)).rejects.toThrow(
			/rate limit/
		);
	});
});
