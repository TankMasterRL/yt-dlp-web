// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { NO_RELAY } from './src/lib/relay/protocol';
import {
	basePathFromEnv,
	documentDirectives,
	headersFor,
	relayOriginFromEnv,
	securityHeaderRules,
	serializeCsp,
	workerDirectives
} from './csp.config.js';

describe('CSP', () => {
	it('keeps production strict: no unsafe-eval, Trusted Types enforced', () => {
		const csp = serializeCsp(documentDirectives({ relayOrigin: null, dev: false }));
		expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
		expect(csp).not.toContain("'unsafe-eval'");
		expect(csp).not.toMatch(/style-src 'self' 'unsafe-inline'/);
		expect(csp).toContain("require-trusted-types-for 'script'");
		expect(csp).toContain('trusted-types svelte-trusted-html yt-dlp-web-worker-url');
	});

	it('allows exactly one extra origin: the relay', () => {
		const csp = serializeCsp(
			documentDirectives({ relayOrigin: 'https://relay.example.workers.dev', dev: false })
		);
		expect(csp).toContain("connect-src 'self' https://relay.example.workers.dev;");
	});

	it('takes the relay origin from VITE_RELAY_URL: none when it is this origin, or there is no relay', () => {
		expect(relayOriginFromEnv({ VITE_RELAY_URL: 'https://relay.example.workers.dev/x' })).toBe(
			'https://relay.example.workers.dev'
		);
		expect(relayOriginFromEnv({})).toBeNull();
		expect(relayOriginFromEnv({ VITE_RELAY_URL: NO_RELAY })).toBeNull();
	});

	it('gives workers wasm but no Trusted Types policies', () => {
		const csp = serializeCsp(workerDirectives({ relayOrigin: 'https://r.example' }));
		expect(csp).toBe(
			"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://r.example; require-trusted-types-for 'script'; trusted-types 'none'"
		);
	});

	it('quotes hashes but not schemes or URLs', () => {
		expect(
			serializeCsp({
				'style-src-attr': ['unsafe-hashes', 'sha256-abc='],
				'img-src': ['self', 'blob:']
			})
		).toBe("style-src-attr 'unsafe-hashes' 'sha256-abc='; img-src 'self' blob:");
	});
});

describe('security headers (for hosts that can send them)', () => {
	const rules = securityHeaderRules({ relayOrigin: 'https://r.example' });

	it('forbids framing and sniffing, isolates the window, and switches off unused features', () => {
		const headers = headersFor('/library/', rules);
		expect(headers['Content-Security-Policy']).toBe(
			"frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
		);
		expect(headers).toMatchObject({
			'X-Frame-Options': 'DENY',
			'X-Content-Type-Options': 'nosniff',
			'Referrer-Policy': 'no-referrer',
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Resource-Policy': 'same-origin'
		});
		expect(headers['Permissions-Policy']).toMatch(/(^|, )camera=\(\)(, |$)/);
		expect(headers['Permissions-Policy']).toMatch(/(^|, )microphone=\(\)(, |$)/);
		// Nothing here needs SharedArrayBuffer: no cross-origin isolation.
		expect(headers).not.toHaveProperty('Cross-Origin-Embedder-Policy');
		expect(headers).not.toHaveProperty('Cache-Control');
	});

	it("gives worker scripts their own CSP — a page's <meta> policy never reaches a worker", () => {
		const csp = headersFor('/_app/immutable/workers/engine.worker-abc.js', rules)[
			'Content-Security-Policy'
		];
		// Rules merge like _headers files: both policies apply, the worker's is the one that bites.
		expect(csp.split(', ')).toEqual([
			"frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
			serializeCsp(workerDirectives({ relayOrigin: 'https://r.example' }))
		]);
	});

	it('caches only content-hashed files forever', () => {
		expect(headersFor('/_app/immutable/chunks/x.js', rules)['Cache-Control']).toBe(
			'public, max-age=31536000, immutable'
		);
		expect(headersFor('/pyodide/pyodide.asm.wasm', rules)).not.toHaveProperty('Cache-Control');
		expect(headersFor('/_app/version.json', rules)).not.toHaveProperty('Cache-Control');
	});

	it('follows a subpath deploy', () => {
		const based = securityHeaderRules({ relayOrigin: null, base: '/yt-dlp-web' });
		expect(based.map((r) => r.path)).toEqual([
			'/yt-dlp-web/*',
			'/yt-dlp-web/_app/immutable/workers/*',
			'/yt-dlp-web/_app/immutable/*'
		]);
		expect(
			headersFor('/yt-dlp-web/_app/immutable/workers/w.js', based)['Content-Security-Policy']
		).toContain("connect-src 'self';");
		expect(headersFor('/elsewhere/', based)).toEqual({});
	});

	it('matches whole paths, with * as the only wildcard', () => {
		expect(
			headersFor('/_app/immutable/workersX/w.js', rules)['Content-Security-Policy']
		).not.toContain('wasm-unsafe-eval');
		expect(headersFor('/_app/immutable/workers', rules)['Content-Security-Policy']).not.toContain(
			'wasm-unsafe-eval'
		);
	});
});

describe('BASE_PATH', () => {
	it.each([
		[undefined, ''],
		['', ''],
		['yt-dlp-web', '/yt-dlp-web'],
		['/yt-dlp-web/', '/yt-dlp-web'],
		['//a/b//', '/a/b']
	])('normalizes %j to %j', (raw, base) => {
		expect(basePathFromEnv(raw === undefined ? {} : { BASE_PATH: raw })).toBe(base);
	});
});
