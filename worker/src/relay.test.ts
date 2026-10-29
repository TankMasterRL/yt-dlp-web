// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { RelayHeader, decodeHeaderList, encodeHeaderJson } from '../../src/lib/relay/protocol';
import { parseHostPatterns } from './policy';
import { handleRelay, type RelayConfig, type RelayDeps } from './relay';

const SELF = 'https://relay.example';
const APP = 'https://app.example';

const config: RelayConfig = {
	allowedHosts: parseHostPatterns('youtube.com, *.youtube.com, *.googlevideo.com'),
	allowedOrigins: new Set([APP]),
	maxRequestBodyBytes: 1024,
	maxBufferedBytes: 64
};

type Upstream = RelayDeps['fetchUpstream'];

function relay(
	init: { method?: string; url?: string; headers?: Record<string, string>; body?: BodyInit } = {},
	upstream: Upstream = async () =>
		new Response('hello', { headers: { 'Content-Type': 'text/html' } }),
	extra: Partial<RelayDeps> = {}
) {
	const headers = new Headers(init.headers);
	if (init.url !== undefined) headers.set(RelayHeader.url, init.url);
	const fetchUpstream = vi.fn(upstream);
	const request = new Request(`${SELF}/relay`, {
		method: init.method ?? 'GET',
		headers,
		body: init.body
	});
	return { response: handleRelay(request, config, { fetchUpstream, ...extra }), fetchUpstream };
}

const WATCH = 'https://www.youtube.com/watch?v=abc';

describe('request validation', () => {
	it('requires X-Relay-Url', async () => {
		expect((await relay().response).status).toBe(400);
	});

	it('refuses targets off the allowlist', async () => {
		const { response, fetchUpstream } = relay({ url: 'https://example.com/' });
		expect((await response).status).toBe(403);
		expect(fetchUpstream).not.toHaveBeenCalled();
	});

	it('refuses navigations even with a valid target', async () => {
		const { response } = relay({ url: WATCH, headers: { 'Sec-Fetch-Mode': 'navigate' } });
		expect((await response).status).toBe(403);
	});

	it('refuses browsers on origins that are not allowed', async () => {
		const { response } = relay({ url: WATCH, headers: { Origin: 'https://evil.example' } });
		expect((await response).status).toBe(403);
	});

	it('refuses methods other than GET, HEAD and POST', async () => {
		expect((await relay({ url: WATCH, method: 'PUT' }).response).status).toBe(405);
	});

	it('refuses oversized request bodies', async () => {
		const { response } = relay({ url: WATCH, method: 'POST', body: 'x'.repeat(2048) });
		expect((await response).status).toBe(413);
	});

	it('refuses malformed tunnelled headers', async () => {
		const { response } = relay({ url: WATCH, headers: { [RelayHeader.headers]: '{"no": 1}' } });
		expect((await response).status).toBe(400);
	});

	it('rate-limits per client', async () => {
		const limiter = { limit: vi.fn(async () => ({ success: false })) };
		const { response } = relay(
			{ url: WATCH, headers: { 'CF-Connecting-IP': '203.0.113.9' } },
			undefined,
			{
				limiter
			}
		);
		expect((await response).status).toBe(429);
		expect(limiter.limit).toHaveBeenCalledWith({ key: '203.0.113.9' });
	});
});

describe('CORS', () => {
	it('answers preflights from allowed origins, cacheably', async () => {
		const { response } = relay({
			method: 'OPTIONS',
			headers: { Origin: APP, 'Access-Control-Request-Method': 'POST' }
		});
		const res = await response;
		expect(res.status).toBe(204);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP);
		expect(res.headers.get('Access-Control-Allow-Headers')).toContain(RelayHeader.url);
		expect(Number(res.headers.get('Access-Control-Max-Age'))).toBeGreaterThan(0);
	});

	it('refuses preflights from other origins', async () => {
		const { response } = relay({ method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
		expect((await response).status).toBe(403);
	});

	it('grants and exposes the relay headers to allowed origins', async () => {
		const res = await relay({ url: WATCH, headers: { Origin: APP } }).response;
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP);
		expect(res.headers.get('Access-Control-Expose-Headers')).toContain(RelayHeader.headers);
		expect(res.headers.get('Vary')).toContain('Origin');
	});
});

describe('upstream request', () => {
	it('performs exactly one request and never follows redirects', async () => {
		const { response, fetchUpstream } = relay({ url: WATCH });
		await response;
		expect(fetchUpstream).toHaveBeenCalledTimes(1);
		expect(fetchUpstream.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'manual' });
	});

	it('forwards tunnelled headers, including ones XHR cannot set', async () => {
		const { response, fetchUpstream } = relay({
			url: WATCH,
			headers: {
				[RelayHeader.headers]: encodeHeaderJson([
					['Cookie', 'SOCS=abc'],
					['Referer', 'https://www.youtube.com/'],
					['User-Agent', 'yt-dlp-web'],
					['Connection', 'keep-alive'],
					['Host', 'evil.example'],
					['CF-Connecting-IP', '1.2.3.4'],
					['X-Forwarded-For', '1.2.3.4']
				])
			}
		});
		await response;
		const sent = new Headers(fetchUpstream.mock.calls[0][1].headers);
		expect(sent.get('Cookie')).toBe('SOCS=abc');
		expect(sent.get('Referer')).toBe('https://www.youtube.com/');
		expect(sent.get('User-Agent')).toBe('yt-dlp-web');
		for (const dropped of ['Connection', 'Host', 'CF-Connecting-IP', 'X-Forwarded-For']) {
			expect(sent.has(dropped), dropped).toBe(false);
		}
	});

	it('forwards POST bodies', async () => {
		const { response, fetchUpstream } = relay({
			url: 'https://www.youtube.com/youtubei/v1/player',
			method: 'POST',
			body: '{"videoId":"abc"}'
		});
		await response;
		const init = fetchUpstream.mock.calls[0][1];
		expect(init.method).toBe('POST');
		expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"videoId":"abc"}');
	});

	it('reports unreachable upstreams as 502', async () => {
		const res = await relay({ url: WATCH }, async () => {
			throw new TypeError('network down');
		}).response;
		expect(res.status).toBe(502);
		expect(res.headers.get(RelayHeader.error)).toMatch(/network down/);
	});
});

describe('relayed response', () => {
	it('tunnels status, headers and Set-Cookie as data', async () => {
		const upstreamHeaders = new Headers({ 'Content-Type': 'text/html', 'X-Custom': 'yes' });
		upstreamHeaders.append('Set-Cookie', 'a=1; Path=/');
		upstreamHeaders.append('Set-Cookie', 'b=2; Expires=Wed, 21 Oct 2037 07:28:00 GMT');
		const res = await relay(
			{ url: WATCH },
			async () => new Response('page', { headers: upstreamHeaders })
		).response;
		expect(res.status).toBe(200);
		expect(res.headers.get(RelayHeader.status)).toBe('200');
		const tunnelled = decodeHeaderList(res.headers.get(RelayHeader.headers));
		expect(tunnelled).toContainEqual(['content-type', 'text/html']);
		expect(tunnelled).toContainEqual(['x-custom', 'yes']);
		expect(tunnelled.filter(([k]) => k === 'set-cookie').map(([, v]) => v)).toEqual([
			'a=1; Path=/',
			'b=2; Expires=Wed, 21 Oct 2037 07:28:00 GMT'
		]);
		expect(res.headers.has('Set-Cookie')).toBe(false);
		expect(await res.text()).toBe('page');
	});

	it('turns redirects into data instead of real 3xx responses', async () => {
		const res = await relay(
			{ url: WATCH },
			async () => new Response(null, { status: 302, headers: { Location: 'https://youtu.be/x' } })
		).response;
		expect(res.status).toBe(200);
		expect(res.headers.get(RelayHeader.status)).toBe('302');
		expect(res.headers.has('Location')).toBe(false);
		expect(decodeHeaderList(res.headers.get(RelayHeader.headers))).toContainEqual([
			'location',
			'https://youtu.be/x'
		]);
	});

	it('passes 4xx/5xx statuses through', async () => {
		const res = await relay({ url: WATCH }, async () => new Response('gone', { status: 410 }))
			.response;
		expect(res.status).toBe(410);
		expect(res.headers.get(RelayHeader.status)).toBe('410');
	});

	it('can never be rendered as a document of the relay origin', async () => {
		const res = await relay({ url: WATCH }).response;
		expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
		expect(res.headers.get('Content-Security-Policy')).toMatch(/sandbox/);
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(res.headers.get('Content-Disposition')).toBe('attachment');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});

	it('drops encoding headers the runtime already decoded', async () => {
		const res = await relay(
			{ url: WATCH },
			async () =>
				new Response('decoded', {
					headers: { 'Content-Encoding': 'gzip', 'Content-Length': '40' }
				})
		).response;
		const names = decodeHeaderList(res.headers.get(RelayHeader.headers)).map(([k]) => k);
		expect(names).not.toContain('content-encoding');
		expect(names).not.toContain('content-length');
	});

	it('streams ranged media untouched', async () => {
		const { response, fetchUpstream } = relay(
			{
				url: 'https://rr1---sn-x.googlevideo.com/videoplayback?id=1',
				headers: { [RelayHeader.headers]: encodeHeaderJson([['Range', 'bytes=0-9']]) }
			},
			async () =>
				new Response('0123456789', {
					status: 206,
					headers: { 'Content-Range': 'bytes 0-9/100', 'Content-Length': '10' }
				})
		);
		const ranged = await response;
		expect(new Headers(fetchUpstream.mock.calls[0][1].headers).get('Range')).toBe('bytes=0-9');
		expect(ranged.status).toBe(206);
		expect(decodeHeaderList(ranged.headers.get(RelayHeader.headers))).toContainEqual([
			'content-range',
			'bytes 0-9/100'
		]);
		expect(await ranged.text()).toBe('0123456789');
	});
});

describe('X-Relay-Max-Bytes', () => {
	const big = 'x'.repeat(100);

	it('delivers a body within the cap untouched', async () => {
		const res = await relay(
			{ url: WATCH, headers: { [RelayHeader.maxBytes]: '50' } },
			async () => new Response('small')
		).response;
		expect(res.headers.has(RelayHeader.truncated)).toBe(false);
		expect(await res.text()).toBe('small');
	});

	it('cuts a longer body at the cap and says so', async () => {
		const res = await relay(
			{ url: WATCH, headers: { [RelayHeader.maxBytes]: '10' } },
			async () => new Response(big)
		).response;
		expect(res.headers.get(RelayHeader.truncated)).toBe('1');
		expect(await res.text()).toBe('x'.repeat(10));
	});

	it('never buffers more than the configured ceiling', async () => {
		const res = await relay(
			{ url: WATCH, headers: { [RelayHeader.maxBytes]: '1000000' } },
			async () => new Response(big)
		).response;
		expect(res.headers.get(RelayHeader.truncated)).toBe('1');
		expect((await res.text()).length).toBe(config.maxBufferedBytes);
	});
});
