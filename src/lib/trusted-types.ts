/**
 * Trusted Types: production CSP sets `require-trusted-types-for 'script'`, so
 * `new Worker(url)` only accepts a TrustedScriptURL. This is the one policy our
 * code creates (named in svelte.config.js), and it admits same-origin scripts
 * only — injected markup can never talk it into starting a foreign worker.
 *
 * TypeScript's DOM lib has no Trusted Types typings, hence the local shapes.
 */
interface ScriptUrlPolicy {
	createScriptURL(input: string): unknown;
}
interface TrustedTypesFactory {
	createPolicy(name: string, rules: { createScriptURL(input: string): string }): ScriptUrlPolicy;
}

export const WORKER_URL_POLICY = 'yt-dlp-web-worker-url';

let policy: ScriptUrlPolicy | null | undefined;

export function sameOriginScriptUrl(input: string, here: string): string {
	const resolved = new URL(input, here);
	if (resolved.origin !== new URL(here).origin) {
		throw new TypeError(`Refusing to start a worker from another origin: ${resolved.href}`);
	}
	// Worker scripts are files this app serves — never blob: or data: URLs, even
	// same-origin ones minted at runtime.
	if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
		throw new TypeError(`Refusing to start a worker from a ${resolved.protocol} URL`);
	}
	return resolved.href;
}

/** A worker script URL acceptable to `new Worker()` under enforced Trusted Types. */
export function trustedWorkerUrl(url: string): string {
	if (policy === undefined) {
		const factory = (globalThis as { trustedTypes?: TrustedTypesFactory }).trustedTypes;
		policy = factory
			? factory.createPolicy(WORKER_URL_POLICY, {
					createScriptURL: (input) => sameOriginScriptUrl(input, location.href)
				})
			: null;
	}
	// Without Trusted Types support the same check still applies.
	return (policy ? policy.createScriptURL(url) : sameOriginScriptUrl(url, location.href)) as string;
}
