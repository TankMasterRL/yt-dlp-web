import adapter from '@sveltejs/adapter-static';
import { sveltekit, type Config as KitConfig } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import {
	basePathFromEnv,
	documentDirectives,
	headersFor,
	relayOriginFromEnv,
	securityHeaderRules
} from './csp.config.js';

/** SvelteKit's CSP directives, a type it does not export by name. */
type CspDirectives = NonNullable<NonNullable<KitConfig['csp']>['directives']>;

/**
 * `vite preview` sends the security headers a real deploy sends (`build/_headers`,
 * `deploy/Caddyfile` — the same rules), so e2e proves the app works under them:
 * the workers' own CSP ('wasm-unsafe-eval' only, Trusted Types with no policies —
 * a <meta> tag cannot reach a worker), no framing, COOP/CORP, no unused features.
 */
function securityHeaders(): Plugin {
	return {
		name: 'yt-dlp-web:security-headers',
		configurePreviewServer(server) {
			const rules = securityHeaderRules({
				relayOrigin: relayOriginFromEnv(),
				base: basePathFromEnv()
			});
			server.middlewares.use((req, res, next) => {
				const path = (req.url ?? '/').split('?')[0];
				for (const [name, value] of Object.entries(headersFor(path, rules)))
					res.setHeader(name, value);
				next();
			});
		}
	};
}

export default defineConfig({
	plugins: [
		sveltekit({
			preprocess: vitePreprocess(),
			// Fully client-side: yt-dlp runs in Pyodide in a Web Worker, so there is no
			// server component. Every route is prerendered; the fallback covers deep
			// links on hosts (GitHub Pages) that serve 404.html for unknown paths.
			adapter: adapter({ fallback: '404.html' }),
			// Serve from a subpath (e.g. GitHub Pages) with BASE_PATH=/repo-name at build time.
			paths: { base: basePathFromEnv() },
			// Nothing reads `updated`, so no hourly fetch of _app/version.json (SvelteKit 2
			// never polled). SvelteKit 3 still checks it when the tab regains focus.
			version: { pollInterval: 0 },
			csp: {
				mode: 'hash',
				// The relay origin (VITE_RELAY_URL) is baked in at build time: it is the
				// only extra origin the page may connect to.
				directives: documentDirectives({
					relayOrigin: relayOriginFromEnv(),
					dev: process.argv.includes('dev')
				}) as CspDirectives
			}
		}),
		svelteTesting(),
		securityHeaders()
	],
	define: {
		// Which FFmpeg core scripts/sync-assets.ts ships, so the page can name its license.
		'import.meta.env.YT_DLP_WEB_FFMPEG': JSON.stringify(process.env.YT_DLP_WEB_FFMPEG ?? '')
	},
	// NOTE: No cross-origin isolation (COOP/COEP) — nothing here needs
	// SharedArrayBuffer: Python I/O is synchronous XHR inside a Worker, and both
	// FFmpeg cores (ffmpeg.wasm's, and the remux core) are single-threaded.
	worker: {
		format: 'es'
	},
	test: {
		globals: true,
		// The Pyodide integration test boots a real interpreter; the workerd tests a runtime.
		testTimeout: 60_000,
		hookTimeout: 120_000,
		projects: [
			{
				// Browser-side code and Svelte components: jsdom, Svelte's browser build.
				extends: true,
				test: {
					name: 'unit',
					environment: 'jsdom',
					setupFiles: ['./vitest-setup.ts'],
					include: ['src/**/*.{test,spec}.ts'],
					exclude: ['src/**/*.integration.test.ts']
				}
			},
			{
				// Runtimes that must resolve like Node, not like a browser (svelteTesting
				// adds the "browser" condition, which swaps in stubs for packages such as
				// ws): real Pyodide, the Worker in workerd, config and build scripts.
				// #lib needs no alias here: package.json's imports maps it, as Node does.
				// Vitest 5 projects inherit the root config, svelteTesting() included,
				// unless they say otherwise.
				extends: false,
				test: {
					name: 'node',
					environment: 'node',
					// Not inherited (`extends: false`): the real Pyodide, FFmpeg and
					// workerd boots need far more than the 10 s default.
					testTimeout: 60_000,
					hookTimeout: 120_000,
					include: [
						'src/**/*.integration.test.ts',
						'worker/**/*.test.ts',
						'scripts/**/*.test.ts',
						'*.test.ts'
					]
				}
			}
		]
	}
});
