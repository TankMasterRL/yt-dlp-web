import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { basePathFromEnv, documentDirectives, relayOriginFromEnv } from './csp.config.js';

// Serve from a subpath (e.g. GitHub Pages) with BASE_PATH=/repo-name at build time.
const base = basePathFromEnv();

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// Fully client-side: yt-dlp runs in Pyodide in a Web Worker, so there is no
		// server component. Every route is prerendered; the fallback covers deep
		// links on hosts (GitHub Pages) that serve 404.html for unknown paths.
		adapter: adapter({ fallback: '404.html' }),
		paths: { base },
		csp: {
			mode: 'hash',
			// The relay origin (VITE_RELAY_URL) is baked in at build time: it is the
			// only extra origin the page may connect to.
			directives: /** @type {import('@sveltejs/kit').CspDirectives} */ (
				documentDirectives({
					relayOrigin: relayOriginFromEnv(),
					dev: process.argv.includes('dev')
				})
			)
		}
	}
};

export default config;
