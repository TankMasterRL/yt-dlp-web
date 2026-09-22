// @vitest-environment node
/**
 * Boots the REAL Pyodide runtime with the REAL pinned yt-dlp wheels and drives
 * yt-dlp through a fixture transport — the same JS↔Python boundary the engine
 * worker uses, minus the synchronous XHR. Skips itself when the wheels have not
 * been fetched (`bun run fetch:wheels`); Dockerfile.test fetches them at image
 * build, so CI always runs it.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPyodide, type PyodideInterface } from 'pyodide';
import { beforeAll, describe, expect, it } from 'vitest';
import { bootEngine, type Engine } from './runtime';
import type { TransportRequest, TransportResponse } from './transport';
import { WHEELS, sha256Hex } from './wheels';

const cacheDir = join(process.cwd(), '.wheel-cache');
const wheelsPresent = WHEELS.every((w) => existsSync(join(cacheDir, w.file)));

const enc = new TextEncoder();
const MP4_BYTES = new Uint8Array([
	0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 0, 0, 0, 0, 109, 112, 52, 50, 105, 115, 111, 109
]);

type Fixture = (req: TransportRequest) => TransportResponse;
const ok = (body: Uint8Array | string, headers: [string, string][] = []): TransportResponse => ({
	status: 200,
	headers,
	body: typeof body === 'string' ? enc.encode(body) : body,
	truncated: false
});

const PAGE = `<!doctype html><html><head>
<title>Fixture page</title>
<meta property="og:title" content="Big Buck Fixture">
</head><body>
<video controls>
  <source src="https://media.fixtures.test/bbf-360.mp4" type="video/mp4" size="360">
  <source src="https://media.fixtures.test/bbf-720.mp4" type="video/mp4" size="720">
</video>
</body></html>`;

const fixtures: Record<string, Fixture> = {
	'https://media.fixtures.test/clip.mp4': () =>
		ok(MP4_BYTES, [
			['Content-Type', 'video/mp4'],
			['Content-Length', String(MP4_BYTES.length)]
		]),
	'https://www.fixtures.test/watch': () => ok(PAGE, [['Content-Type', 'text/html; charset=utf-8']]),
	'https://www.fixtures.test/moved': () => ({
		status: 302,
		headers: [
			['Location', 'https://media.fixtures.test/clip.mp4'],
			['Set-Cookie', 'session=www-only; Path=/; Domain=www.fixtures.test'],
			['Set-Cookie', 'shared=everywhere; Path=/; Domain=.fixtures.test']
		],
		body: new Uint8Array(),
		truncated: false
	}),
	// Bodies cut off at maxBytes: a media file only needs its first bytes sniffed,
	// but a page that yt-dlp must read in full has to fail loudly.
	'https://media.fixtures.test/huge.mp4': () => ({
		...ok(MP4_BYTES, [['Content-Type', 'video/mp4']]),
		truncated: true
	}),
	'https://www.fixtures.test/huge-page': () => ({
		...ok(PAGE, [['Content-Type', 'text/html']]),
		truncated: true
	}),
	'https://www.fixtures.test/missing': () => ({
		status: 404,
		headers: [['Content-Type', 'text/plain']],
		body: enc.encode('nope'),
		truncated: false
	})
};

describe.skipIf(!wheelsPresent)('yt-dlp in Pyodide (real runtime, real pinned wheels)', () => {
	let engine: Engine;
	let py: PyodideInterface;
	const seen: TransportRequest[] = [];

	beforeAll(async () => {
		engine = await bootEngine({
			loadPyodide: () => loadPyodide(),
			readWheel: async (pin) => readFile(join(cacheDir, pin.file)),
			transport: (req) => {
				seen.push(req);
				const fixture = fixtures[req.url];
				if (!fixture) throw new Error(`no fixture for ${req.method} ${req.url}`);
				return fixture(req);
			}
		});
		py = engine.pyodide;
	});

	it('fetched wheels match their pins', async () => {
		for (const pin of WHEELS) {
			expect(await sha256Hex(new Uint8Array(await readFile(join(cacheDir, pin.file))))).toBe(pin.sha256);
		}
	});

	it('imports the pinned yt-dlp and yt-dlp-ejs versions', () => {
		// yt-dlp normalises its version to zero-padded date parts (2026.08.19).
		const ytdlp = WHEELS.find((w) => w.name === 'yt-dlp')!;
		const expected = ytdlp.version.replace(/\.(\d)(?=\.|$)/g, '.0$1');
		expect(py.runPython('import yt_dlp.version; yt_dlp.version.__version__')).toBe(expected);
		expect(py.runPython('import yt_dlp_ejs; yt_dlp_ejs.version')).toBe(
			WHEELS.find((w) => w.name === 'yt-dlp-ejs')!.version
		);
	});

	it("replaces yt-dlp's socket-based request handlers with RelayRH", () => {
		const handlers = py.runPython(`
from yt_dlp.networking import common
import yt_dlp
with yt_dlp.YoutubeDL({'quiet': True}) as ydl:
    keys = sorted(ydl._request_director.handlers.keys())
str(keys)`);
		expect(handlers).toBe("['Relay']");
	});

	it('extracts a direct media URL through the transport', () => {
		seen.length = 0;
		const result = engine.extract('https://media.fixtures.test/clip.mp4');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.info.title).toBe('clip');
		expect(result.info.url).toBe('https://media.fixtures.test/clip.mp4');
		expect(result.info.ext).toBe('mp4');
		// yt-dlp read the page through our transport, with a body cap in place.
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((r) => r.maxBytes !== null && r.maxBytes > 0)).toBe(true);
	});

	it('extracts <video> sources from an HTML page', () => {
		const result = engine.extract('https://www.fixtures.test/watch');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const entry = result.info.entries ? result.info.entries[0] : result.info;
		// The generic extractor numbers HTML5 media entries: "<og:title> (1)".
		expect(entry.title).toMatch(/^Big Buck Fixture/);
		const formats: { url?: string }[] = entry.formats ?? [entry];
		const urls = formats.map((f) => f.url).sort();
		expect(urls).toEqual([
			'https://media.fixtures.test/bbf-360.mp4',
			'https://media.fixtures.test/bbf-720.mp4'
		]);
	});

	it('follows redirects hop by hop, scoping cookies to their domain', () => {
		seen.length = 0;
		const result = engine.extract('https://www.fixtures.test/moved');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.info.url).toBe('https://media.fixtures.test/clip.mp4');
		const hop2 = seen.find((r) => r.url === 'https://media.fixtures.test/clip.mp4')!;
		const cookie = hop2.headers.find(([k]) => k.toLowerCase() === 'cookie')?.[1] ?? '';
		expect(cookie).toContain('shared=everywhere');
		expect(cookie).not.toContain('session=www-only');
	});

	it("streams yt-dlp's progress lines to a callback while it works", () => {
		const lines: [string, string][] = [];
		const result = engine.extract('https://www.fixtures.test/watch', {}, (level, line) =>
			lines.push([level, line])
		);
		expect(result.ok).toBe(true);
		expect(lines).toContainEqual(['info', expect.stringMatching(/^\[generic\] watch: /)]);
		expect(lines.some(([, line]) => line.startsWith('[debug]'))).toBe(false);
		expect(lines).toContainEqual([
			'warning',
			expect.stringMatching(/Falling back on generic information extractor/)
		]);
	});

	it('sniffs a truncated media body without needing the rest', () => {
		const result = engine.extract('https://media.fixtures.test/huge.mp4');
		expect(result.ok).toBe(true);
	});

	it('fails loudly when an extractor needs bytes the transport cut off', () => {
		const result = engine.extract('https://www.fixtures.test/huge-page');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/too large to process in the browser/);
	});

	it('surfaces upstream HTTP errors as a failed extraction, not a crash', () => {
		const result = engine.extract('https://www.fixtures.test/missing');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/404/);
	});

	it('reports transport failures as a failed extraction', () => {
		const result = engine.extract('https://www.fixtures.test/not-in-fixtures');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/no fixture/);
	});
});
