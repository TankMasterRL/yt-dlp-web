import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { relayOriginFromEnv, serializeCsp, workerDirectives } from './csp.config.js';

/**
 * `vite preview` serves worker scripts with the header CSP a self-hosted deploy
 * sends (a <meta> tag cannot reach a worker), so e2e proves Pyodide + yt-dlp run
 * under it: 'wasm-unsafe-eval' only, and Trusted Types with no policies at all.
 */
function workerCspHeader(): Plugin {
	return {
		name: 'yt-dlp-web:worker-csp',
		configurePreviewServer(server) {
			const csp = serializeCsp(workerDirectives({ relayOrigin: relayOriginFromEnv() }));
			server.middlewares.use((req, res, next) => {
				if (req.url?.includes('/_app/immutable/workers/')) {
					res.setHeader('Content-Security-Policy', csp);
				}
				next();
			});
		}
	};
}

export default defineConfig({
	plugins: [sveltekit(), svelteTesting(), workerCspHeader()],
	// NOTE: No cross-origin isolation (COOP/COEP) — nothing here needs
	// SharedArrayBuffer: Python I/O is synchronous XHR inside a Worker, and the
	// opt-in ffmpeg.wasm uses the single-threaded core.
	worker: {
		format: 'es'
	},
	test: {
		environment: 'jsdom',
		setupFiles: ['./vitest-setup.ts'],
		globals: true,
		include: [
			'src/**/*.{test,spec}.{js,ts}',
			'worker/**/*.{test,spec}.ts',
			'scripts/**/*.test.ts',
			'*.test.ts'
		],
		exclude: ['tests/e2e/**', 'node_modules/**'],
		// The Pyodide integration test boots a real interpreter.
		testTimeout: 60_000,
		hookTimeout: 120_000
	}
});
