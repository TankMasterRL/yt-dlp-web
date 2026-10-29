import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { headersFor, securityHeaderRules } from '../csp.config.js';
import { CADDYFILE_PATH, caddyfile, caddyHeaderPlan, headersFile } from './write-headers';

describe('_headers (Cloudflare Pages, Workers Static Assets, Netlify)', () => {
	it('writes one block per rule, in order', () => {
		expect(
			headersFile([
				{ path: '/*', headers: { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' } },
				{ path: '/_app/immutable/*', headers: { 'Cache-Control': 'immutable' } }
			])
		).toBe(
			'/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n\n/_app/immutable/*\n  Cache-Control: immutable\n'
		);
	});

	it('carries every security header rule', () => {
		const rules = securityHeaderRules({ relayOrigin: 'https://relay.example' });
		const file = headersFile(rules);
		for (const rule of rules) {
			expect(file).toContain(`${rule.path}\n`);
			for (const [name, value] of Object.entries(rule.headers))
				expect(file).toContain(`  ${name}: ${value}\n`);
		}
	});
});

describe('deploy/Caddyfile', () => {
	it('is what the generator writes — edit csp.config.js and regenerate, never the file', () => {
		const committed = readFileSync(new URL(`../${CADDYFILE_PATH}`, import.meta.url), 'utf8');
		expect(committed).toBe(caddyfile());
	});

	it('sets each header field exactly once for any path, to what _headers would give it', () => {
		// Caddy orders `header` directives itself, so two directives setting one
		// field could silently replace the worker CSP. The plan uses mutually
		// exclusive matchers instead; check it against the _headers semantics.
		const rules = securityHeaderRules({ relayOrigin: '{$RELAY_ORIGIN}' });
		const plan = caddyHeaderPlan(rules);
		const matches = (m: { path?: string; notPath?: string }, path: string) => {
			const re = (p: string) => new RegExp(`^${p.replaceAll('.', '\\.').replaceAll('*', '.*')}$`);
			return (
				(m.path === undefined || re(m.path).test(path)) &&
				(m.notPath === undefined || !re(m.notPath).test(path))
			);
		};
		for (const path of [
			'/',
			'/library/',
			'/404.html',
			'/_app/immutable/workers/engine.worker-x.js',
			'/_app/immutable/chunks/a.js',
			'/pyodide/pyodide.mjs'
		]) {
			const got: Record<string, string> = {};
			for (const directive of plan) {
				if (!matches(directive.matcher, path)) continue;
				for (const [name, value] of Object.entries(directive.headers)) {
					expect(got, `${name} set twice for ${path}`).not.toHaveProperty(name);
					got[name] = value;
				}
			}
			expect(got).toEqual(headersFor(path, rules));
		}
	});
});
