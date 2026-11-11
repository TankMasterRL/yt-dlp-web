/**
 * The app's Content Security Policy and security headers, in one place:
 * svelte.config.js turns the document policy into the prerendered <meta> tag;
 * the Vite preview server, `build/_headers` and `deploy/Caddyfile` (both from
 * scripts/write-headers.ts) send the header rules. Plain JS so all can import it.
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

/**
 * BASE_PATH (subpath hosting, e.g. GitHub Pages) normalized to SvelteKit's
 * rules: leading slash, no trailing slash, '' for the site root.
 */
export function basePathFromEnv(env = process.env) {
	const raw = env.BASE_PATH ?? '';
	return raw ? `/${raw.replace(/^\/+|\/+$/g, '')}` : '';
}

/**
 * VITE_RELAY_URL for a build without a relay (NO_RELAY in src/lib/relay/protocol.ts;
 * csp.config.test.ts holds the two together).
 */
const NO_RELAY = 'none';

/**
 * The relay Worker's origin from VITE_RELAY_URL, or null: for same-origin
 * (all-in-one, unset) and for a build without a relay (`none`) alike, the
 * page connects to its own origin only.
 * @param {Record<string, string | undefined>} env
 */
export function relayOriginFromEnv(env = process.env) {
	const url = env.VITE_RELAY_URL;
	return url && url !== NO_RELAY ? new URL(url).origin : null;
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

/**
 * What a <meta> CSP cannot say. The document's full policy stays in the
 * prerendered <meta> tag (SvelteKit's script hashes change with every build);
 * policies combine, so this header policy only adds — chiefly
 * frame-ancestors, which no <meta> tag can carry.
 */
export const DOCUMENT_HEADER_DIRECTIVES = {
	'frame-ancestors': ['none'],
	'base-uri': ['none'],
	'object-src': ['none']
};

/**
 * Powerful features the app never uses, switched off (it embeds nothing, so no
 * delegation either). Only features browsers recognise: an unknown one is a
 * console error, which e2e fails on.
 */
const UNUSED_FEATURES = [
	'accelerometer',
	'browsing-topics',
	'camera',
	'display-capture',
	'geolocation',
	'gyroscope',
	'hid',
	'magnetometer',
	'microphone',
	'midi',
	'payment',
	'serial',
	'usb',
	'xr-spatial-tracking'
];

/**
 * Response headers for hosts that can set them, as `_headers`-style rules: a
 * path pattern (`*` is the only wildcard) and its headers. Where several rules
 * match, a repeated header's values are joined with a comma, as Cloudflare and
 * Netlify merge `_headers` rules — for CSP, that means both policies apply.
 * No Cross-Origin-Embedder-Policy: nothing here needs SharedArrayBuffer.
 * @param {{ relayOrigin: string | null, base?: string }} options
 * @returns {{ path: string, headers: Record<string, string> }[]}
 */
export function securityHeaderRules({ relayOrigin, base = '' }) {
	return [
		{
			path: `${base}/*`,
			headers: {
				'Content-Security-Policy': serializeCsp(DOCUMENT_HEADER_DIRECTIVES),
				'X-Frame-Options': 'DENY',
				'X-Content-Type-Options': 'nosniff',
				'Referrer-Policy': 'no-referrer',
				'Cross-Origin-Opener-Policy': 'same-origin',
				'Cross-Origin-Resource-Policy': 'same-origin',
				'Permissions-Policy': UNUSED_FEATURES.map((feature) => `${feature}=()`).join(', '),
				// Browsers only honour it over HTTPS; deliberately no includeSubDomains.
				'Strict-Transport-Security': 'max-age=31536000'
			}
		},
		{
			// A worker's CSP comes from its own response; the page's <meta> never reaches it.
			path: `${base}/_app/immutable/workers/*`,
			headers: { 'Content-Security-Policy': serializeCsp(workerDirectives({ relayOrigin })) }
		},
		{
			// Content-hashed names: a changed file is a new URL.
			path: `${base}/_app/immutable/*`,
			headers: { 'Cache-Control': 'public, max-age=31536000, immutable' }
		}
	];
}

/**
 * The headers `rules` give a request path (no query string), merged the way
 * `_headers` files merge them.
 * @param {string} path
 * @param {{ path: string, headers: Record<string, string> }[]} rules
 */
export function headersFor(path, rules) {
	/** @type {Record<string, string>} */
	const merged = {};
	for (const rule of rules) {
		if (!patternRegExp(rule.path).test(path)) continue;
		for (const [name, value] of Object.entries(rule.headers)) {
			merged[name] = merged[name] ? `${merged[name]}, ${value}` : value;
		}
	}
	return merged;
}

/** @param {string} pattern */
function patternRegExp(pattern) {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
	return new RegExp(`^${escaped}$`);
}
