/**
 * A tiny fake video site for hermetic e2e tests, served as the relay's
 * "upstream" by scripts/fixture-relay.ts. yt-dlp's generic extractor handles it,
 * so the whole browser path — sync XHR, relay protocol, CORS, Pyodide, yt-dlp —
 * runs for real without touching the internet. YouTube-specific paths are
 * covered by the @live tests instead (youtube.com is unreachable in CI).
 */
export const FIXTURE_HOSTS = '*.fixtures.test';

export interface Fixture {
	status?: number;
	headers?: Record<string, string>;
	body?: string | Uint8Array<ArrayBuffer>;
}

const WATCH_PAGE = `<!doctype html><html><head>
<title>Fixture page</title>
<meta property="og:title" content="Big Buck Fixture">
</head><body>
<video controls>
  <source src="https://media.fixtures.test/bbf-360.mp4" type="video/mp4">
  <source src="https://media.fixtures.test/bbf-720.mp4" type="video/mp4">
</video>
</body></html>`;

/** 24 bytes of MP4 `ftyp` box: enough for yt-dlp to call it a video file. */
const MP4_STUB = new Uint8Array([
	0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 0, 0, 0, 0, 109, 112, 52, 50, 105, 115, 111, 109
]);

export const FIXTURES: Record<string, Fixture> = {
	'https://www.fixtures.test/watch': {
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
		body: WATCH_PAGE
	},
	'https://www.fixtures.test/moved': {
		status: 302,
		headers: { Location: 'https://www.fixtures.test/watch' }
	},
	'https://media.fixtures.test/bbf-360.mp4': { headers: { 'Content-Type': 'video/mp4' }, body: MP4_STUB },
	'https://media.fixtures.test/bbf-720.mp4': { headers: { 'Content-Type': 'video/mp4' }, body: MP4_STUB }
};

/** A `fetch` over FIXTURES, with Range support, for the relay's upstream seam. */
export async function fixtureFetch(url: string, init: RequestInit = {}): Promise<Response> {
	const fixture = FIXTURES[url];
	if (!fixture) return new Response('fixture not found', { status: 404 });
	const body = typeof fixture.body === 'string' ? new TextEncoder().encode(fixture.body) : fixture.body;
	const headers = new Headers(fixture.headers);
	const range = new Headers(init.headers).get('Range')?.match(/^bytes=(\d+)-(\d*)$/);
	if (range && body) {
		const start = Number(range[1]);
		const end = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1);
		if (start >= body.length) {
			headers.set('Content-Range', `bytes */${body.length}`);
			return new Response(null, { status: 416, headers });
		}
		headers.set('Content-Range', `bytes ${start}-${end}/${body.length}`);
		headers.set('Content-Length', String(end - start + 1));
		return new Response(init.method === 'HEAD' ? null : body.slice(start, end + 1), { status: 206, headers });
	}
	if (body) headers.set('Content-Length', String(body.length));
	return new Response(init.method === 'HEAD' || !body ? null : body, {
		status: fixture.status ?? 200,
		headers
	});
}
