import { createHash } from 'node:crypto';
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// SvelteKit's root component renders its accessibility route announcer with this
// inline style attribute (kit/src/core/sync/write_root.js). Rather than allow
// 'unsafe-inline' styles, 'unsafe-hashes' admits exactly this attribute value and
// nothing else. If a SvelteKit upgrade changes it, the e2e CSP guard fails.
const KIT_ANNOUNCER_STYLE =
	'position: absolute; left: 0; top: 0; clip: rect(0 0 0 0); clip-path: inset(50%); overflow: hidden; white-space: nowrap; width: 1px; height: 1px';
const announcerStyleHash = `sha256-${createHash('sha256').update(KIT_ANNOUNCER_STYLE).digest('base64')}`;

// Serve from a subpath (e.g. GitHub Pages) with BASE_PATH=/repo-name at build
// time. Normalized to SvelteKit's rules: leading slash, no trailing slash.
const rawBase = process.env.BASE_PATH ?? '';
const base = rawBase ? `/${rawBase.replace(/^\/+|\/+$/g, '')}` : '';

// The relay/solve Worker. Unset means same-origin: the Worker serves this build
// via Workers Static Assets and the relay lives at /relay. Otherwise it is the
// ONLY extra origin the page may talk to — baked into CSP at build time.
const relayOrigin = process.env.VITE_RELAY_URL
	? new URL(process.env.VITE_RELAY_URL).origin
	: null;

// Vite's dev server injects <style> tags, talks HMR over a WebSocket and renders
// its error overlay with innerHTML, so the strict policy only applies to builds.
const dev = process.argv.includes('dev');

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
			directives: {
				'default-src': ['none'],
				// Pyodide compiles WebAssembly: 'wasm-unsafe-eval', never 'unsafe-eval'.
				'script-src': ['self', 'wasm-unsafe-eval'],
				'style-src': dev ? ['self', 'unsafe-inline'] : ['self'],
				'style-src-attr': dev ? ['unsafe-inline'] : ['unsafe-hashes', announcerStyleHash],
				// Thumbnails and media are fetched through the relay and shown from
				// blob: URLs, so no third-party image host ever sees the viewer.
				'img-src': ['self', 'blob:', 'data:'],
				'media-src': ['self', 'blob:'],
				'font-src': ['self'],
				'connect-src': [
					'self',
					...(relayOrigin ? [relayOrigin] : []),
					...(dev ? ['ws:'] : [])
				],
				'worker-src': ['self'],
				'manifest-src': ['self'],
				'frame-src': ['none'],
				'object-src': ['none'],
				'base-uri': ['none'],
				'form-action': ['none'],
				...(dev
					? {}
					: {
							// Every DOM-XSS sink must go through a named policy: Svelte's own
							// template policy plus ours for worker script URLs.
							'require-trusted-types-for': ['script'],
							'trusted-types': ['svelte-trusted-html', 'yt-dlp-web-worker-url']
						})
			}
		}
	}
};

export default config;
