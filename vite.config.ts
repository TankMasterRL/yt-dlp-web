import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit(), svelteTesting()],
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
		include: ['src/**/*.{test,spec}.{js,ts}', 'worker/**/*.{test,spec}.ts', 'scripts/**/*.test.ts'],
		exclude: ['tests/e2e/**', 'node_modules/**'],
		// The Pyodide integration test boots a real interpreter.
		testTimeout: 60_000,
		hookTimeout: 120_000
	}
});
