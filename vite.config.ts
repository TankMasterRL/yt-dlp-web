import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import {
	basePathFromEnv,
	headersFor,
	relayOriginFromEnv,
	securityHeaderRules
} from './csp.config.js';

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
	plugins: [sveltekit(), svelteTesting(), securityHeaders()],
	// NOTE: No cross-origin isolation (COOP/COEP) — nothing here needs
	// SharedArrayBuffer: Python I/O is synchronous XHR inside a Worker, and the
	// opt-in ffmpeg.wasm uses the single-threaded core.
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
				resolve: { alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) } },
				test: {
					name: 'node',
					environment: 'node',
					// Not inherited (this project does not `extends: true`): the real
					// Pyodide, ffmpeg.wasm and workerd boots need far more than the 10 s default.
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
