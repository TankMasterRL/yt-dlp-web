/**
 * The app's Content Security Policy, in one place: svelte.config.js turns it
 * into the prerendered <meta> tag; the Vite preview server and the self-host
 * header files (M7) send it as real headers. Plain JS so both can import it.
 */
import { createHash } from 'node:crypto';

// SvelteKit's root component renders its accessibility route announcer with this
// inline style attribute (kit/src/core/sync/write_root.js). Rather than allow
// 'unsafe-inline' styles, 'unsafe-hashes' admits exactly this attribute value and
// nothing else. If a SvelteKit upgrade changes it, the e2e CSP guard fails.
const KIT_ANNOUNCER_STYLE =
	'position: absolute; left: 0; top: 0; clip: rect(0 0 0 0); clip-path: inset(50%); overflow: hidden; white-space: nowrap; width: 1px; height: 1px';
const announcerStyleHash = `sha256-${createHash('sha256').update(KIT_ANNOUNCER_STYLE).digest('base64')}`;

/** Trusted Types policies our own code creates (src/lib/trusted-types.ts). */
export const APP_TRUSTED_TYPES_POLICIES = ['yt-dlp-web-worker-url'];

/** The relay Worker's origin from VITE_RELAY_URL, or null for same-origin (all-in-one). */
export function relayOriginFromEnv(env = process.env) {
	return env.VITE_RELAY_URL ? new URL(env.VITE_RELAY_URL).origin : null;
}

/**
 * Document policy in SvelteKit's `kit.csp.directives` shape (keywords unquoted;
 * SvelteKit adds the hashes of its own inline scripts).
 * @param {{ relayOrigin: string | null, dev: boolean }} options
 */
export function documentDirectives({ relayOrigin, dev }) {
	return {
		'default-src': ['none'],
		// Pyodide compiles WebAssembly: 'wasm-unsafe-eval', never 'unsafe-eval'.
		'script-src': ['self', 'wasm-unsafe-eval'],
		// Vite's dev server injects <style> tags, talks HMR over a WebSocket and
		// renders its error overlay with innerHTML, so dev relaxes these three.
		'style-src': dev ? ['self', 'unsafe-inline'] : ['self'],
		'style-src-attr': dev ? ['unsafe-inline'] : ['unsafe-hashes', announcerStyleHash],
		// Thumbnails and media are fetched through the relay and shown from blob:
		// URLs, so no third-party image host ever sees the viewer.
		'img-src': ['self', 'blob:', 'data:'],
		'media-src': ['self', 'blob:'],
		'font-src': ['self'],
		'connect-src': ['self', ...(relayOrigin ? [relayOrigin] : []), ...(dev ? ['ws:'] : [])],
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
					'trusted-types': ['svelte-trusted-html', ...APP_TRUSTED_TYPES_POLICIES]
				})
	};
}

/**
 * Policy for the app's Web Workers. A same-origin worker gets its CSP from its
 * own response headers — a <meta> tag cannot reach it — so hosts that can set
 * headers send this on worker scripts. The engine worker imports Pyodide,
 * compiles WebAssembly and talks only to its own origin and the relay.
 * @param {{ relayOrigin: string | null }} options
 */
export function workerDirectives({ relayOrigin }) {
	return {
		'default-src': ['none'],
		'script-src': ['self', 'wasm-unsafe-eval'],
		'connect-src': ['self', ...(relayOrigin ? [relayOrigin] : [])],
		'require-trusted-types-for': ['script'],
		// Workers create no Trusted Types policies at all.
		'trusted-types': ['none']
	};
}

const KEYWORDS = new Set([
	'self',
	'none',
	'unsafe-inline',
	'unsafe-eval',
	'wasm-unsafe-eval',
	'unsafe-hashes',
	'strict-dynamic',
	'report-sample',
	'script',
	'allow-duplicates'
]);

/**
 * Serialize directives as a header value, quoting keywords and hashes.
 * @param {Record<string, string[]>} directives
 */
export function serializeCsp(directives) {
	return Object.entries(directives)
		.map(([name, values]) => {
			const quoted = values.map((v) =>
				KEYWORDS.has(v) || /^(sha(256|384|512)|nonce)-/.test(v) ? `'${v}'` : v
			);
			return [name, ...quoted].join(' ');
		})
		.join('; ');
}
