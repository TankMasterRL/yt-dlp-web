/**
 * Which upstream URLs the relay may fetch — its entire SSRF defence.
 *
 * Only https, only default port, no credentials, no IP literals, and the host
 * must match the configured allowlist. Every redirect hop is a separate relay
 * request, so this check runs on every URL the relay ever fetches.
 */
export type HostPattern =
	| { kind: 'exact'; host: string }
	/** `*.example.com` → any subdomain of example.com, at any depth, but not example.com itself. */
	| { kind: 'subdomain'; suffix: string };

/** Parse `a.com, *.b.com` into patterns. Refuses wildcards broad enough to be a mistake. */
export function parseHostPatterns(spec: string): HostPattern[] {
	const patterns: HostPattern[] = [];
	for (const raw of spec.split(',')) {
		const entry = normalizeHost(raw.trim());
		if (!entry) continue;
		if (entry.startsWith('*.')) {
			const base = entry.slice(2);
			if (!base.includes('.') || base.includes('*')) {
				throw new Error(`Host pattern too broad or malformed: "${raw.trim()}"`);
			}
			patterns.push({ kind: 'subdomain', suffix: `.${base}` });
		} else {
			if (entry.includes('*')) throw new Error(`Malformed host pattern: "${raw.trim()}"`);
			patterns.push({ kind: 'exact', host: entry });
		}
	}
	return patterns;
}

export function hostMatches(host: string, patterns: readonly HostPattern[]): boolean {
	const h = normalizeHost(host);
	return patterns.some((p) =>
		p.kind === 'exact' ? h === p.host : h.length > p.suffix.length && h.endsWith(p.suffix)
	);
}

export type TargetCheck = { ok: true; url: URL } | { ok: false; reason: string };

export function checkTarget(raw: string, patterns: readonly HostPattern[]): TargetCheck {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, reason: 'not a valid absolute URL' };
	}
	if (url.protocol !== 'https:') return { ok: false, reason: 'only https targets are relayed' };
	if (url.username || url.password) return { ok: false, reason: 'credentials in the URL' };
	// URL elides the default port, so any explicit port here is a non-default one.
	if (url.port) return { ok: false, reason: 'non-default port' };
	if (isIpLiteral(url.hostname)) return { ok: false, reason: 'IP address targets are not relayed' };
	if (!hostMatches(url.hostname, patterns)) {
		return { ok: false, reason: `host not on the allowlist: ${url.hostname}` };
	}
	return { ok: true, url };
}

function normalizeHost(host: string): string {
	return host.toLowerCase().replace(/\.$/, '');
}

function isIpLiteral(hostname: string): boolean {
	// The WHATWG URL parser canonicalises every IPv4 spelling (hex, octal,
	// single integer) to dotted decimal and brackets IPv6.
	return hostname.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}
