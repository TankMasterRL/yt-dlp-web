// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { documentDirectives, serializeCsp, workerDirectives } from './csp.config.js';

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
