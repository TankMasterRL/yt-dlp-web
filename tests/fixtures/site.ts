/**
 * A tiny fake video site for hermetic e2e tests, served as the relay's
 * "upstream" by scripts/fixture-relay.ts. yt-dlp's generic extractor handles it,
 * so the whole browser path — sync XHR, relay protocol, CORS, Pyodide, yt-dlp —
 * runs for real without touching the internet. YouTube-specific paths are
 * covered by the @live tests instead (youtube.com is unreachable in CI).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FIXTURE_HOSTS = '*.fixtures.test';

/** Real, playable clips: VP8 video, Opus audio (scripts/make-fixture-media.ts). */
const media = (name: string) =>
	new Uint8Array(readFileSync(fileURLToPath(new URL(`./media/${name}`, import.meta.url))));
export const CLIP_360 = media('bbf-360.webm');
export const CLIP_720 = media('bbf-720.webm');
export const CLIP_AUDIO = media('bbf-audio.webm');

/**
 * Separate video-only and audio-only streams, as YouTube serves its best
 * formats: a DASH manifest whose representations are single files (yt-dlp
 * keeps their codecs; `<source>`s inside a <video> would all count as video).
 * `yt:contentLength` is how YouTube's manifests state sizes.
 */
const SPLIT_PAGE = `<!doctype html><html><head>
<title>Split fixture</title>
<meta property="og:title" content="Split Stream Fixture">
</head><body>
<video controls>
  <source src="https://www.fixtures.test/split.mpd" type="application/dash+xml">
</video>
</body></html>`;

const SPLIT_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:yt="http://youtube.com/yt/2012/10/10" type="static"
     mediaPresentationDuration="PT2S" minBufferTime="PT1S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period duration="PT2S">
    <AdaptationSet mimeType="video/webm" contentType="video">
      <Representation id="v360" codecs="vp8" width="640" height="360" frameRate="12" bandwidth="120000">
        <BaseURL yt:contentLength="${CLIP_360.byteLength}">https://media.fixtures.test/bbf-360.webm</BaseURL>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/webm" contentType="audio">
      <Representation id="a1" codecs="opus" audioSamplingRate="48000" bandwidth="128000">
        <BaseURL yt:contentLength="${CLIP_AUDIO.byteLength}">https://media.fixtures.test/bbf-audio.webm</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

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
  <source src="https://media.fixtures.test/bbf-360.webm" type="video/webm">
  <source src="https://media.fixtures.test/bbf-720.webm" type="video/webm">
</video>
</body></html>`;

export const FIXTURES: Record<string, Fixture> = {
	'https://www.fixtures.test/watch': {
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
		body: WATCH_PAGE
	},
	'https://www.fixtures.test/split': {
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
		body: SPLIT_PAGE
	},
	'https://www.fixtures.test/split.mpd': {
		headers: { 'Content-Type': 'application/dash+xml' },
		body: SPLIT_MPD
	},
	'https://www.fixtures.test/moved': {
		status: 302,
		headers: { Location: 'https://www.fixtures.test/watch' }
	},
	'https://media.fixtures.test/bbf-360.webm': {
		headers: { 'Content-Type': 'video/webm' },
		body: CLIP_360
	},
	'https://media.fixtures.test/bbf-720.webm': {
		headers: { 'Content-Type': 'video/webm' },
		body: CLIP_720
	},
	'https://media.fixtures.test/bbf-audio.webm': {
		headers: { 'Content-Type': 'audio/webm' },
		body: CLIP_AUDIO
	},
	// A media host that hands out one-hop redirects, as googlevideo.com sometimes does.
	'https://redirector.fixtures.test/bbf-360.webm': {
		status: 302,
		headers: { Location: 'https://media.fixtures.test/bbf-360.webm' }
	}
};

/** A `fetch` over FIXTURES, with Range support, for the relay's upstream seam. */
export async function fixtureFetch(url: string, init: RequestInit = {}): Promise<Response> {
	const fixture = FIXTURES[url];
	if (!fixture) return new Response('fixture not found', { status: 404 });
	const body =
		typeof fixture.body === 'string' ? new TextEncoder().encode(fixture.body) : fixture.body;
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
		return new Response(init.method === 'HEAD' ? null : body.slice(start, end + 1), {
			status: 206,
			headers
		});
	}
	if (body) headers.set('Content-Length', String(body.length));
	return new Response(init.method === 'HEAD' || !body ? null : body, {
		status: fixture.status ?? 200,
		headers
	});
}
