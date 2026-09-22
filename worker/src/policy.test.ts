// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { checkTarget, hostMatches, parseHostPatterns } from './policy';

const patterns = parseHostPatterns('youtube.com, *.youtube.com, *.googlevideo.com, youtu.be');

describe('host patterns', () => {
	it('match an exact host', () => {
		expect(hostMatches('youtube.com', patterns)).toBe(true);
		expect(hostMatches('youtu.be', patterns)).toBe(true);
	});

	it('match any subdomain depth under a wildcard, but not the apex', () => {
		expect(hostMatches('www.youtube.com', patterns)).toBe(true);
		expect(hostMatches('rr1---sn-4g5e6nsz.googlevideo.com', patterns)).toBe(true);
		expect(hostMatches('googlevideo.com', patterns)).toBe(false);
	});

	it('never match on a bare suffix', () => {
		expect(hostMatches('evilyoutube.com', patterns)).toBe(false);
		expect(hostMatches('youtube.com.evil.example', patterns)).toBe(false);
		expect(hostMatches('notyoutu.be', patterns)).toBe(false);
	});

	it('are case-insensitive and ignore a trailing dot', () => {
		expect(hostMatches('WWW.YouTube.COM', patterns)).toBe(true);
		expect(hostMatches('www.youtube.com.', patterns)).toBe(true);
	});

	it('refuse a bare wildcard in configuration', () => {
		expect(() => parseHostPatterns('*')).toThrow();
		expect(() => parseHostPatterns('*.com')).toThrow();
	});
});

describe('target URL checks (SSRF guard)', () => {
	const allowed = (url: string) => checkTarget(url, patterns);

	it('accept an allowlisted https URL', () => {
		expect(allowed('https://www.youtube.com/watch?v=abc')).toEqual({ ok: true, url: expect.any(URL) });
	});

	it.each([
		['plain http', 'http://www.youtube.com/'],
		['another scheme', 'ftp://www.youtube.com/'],
		['credentials in the URL', 'https://user:pass@www.youtube.com/'],
		['a non-default port', 'https://www.youtube.com:8443/'],
		['an IPv4 literal', 'https://142.250.1.1/'],
		['an IPv6 literal', 'https://[::1]/'],
		['localhost', 'https://localhost/'],
		['a host off the allowlist', 'https://example.com/'],
		['a look-alike host', 'https://youtube.com.evil.example/'],
		['garbage', 'not a url']
	])('reject %s', (_, url) => {
		expect(allowed(url).ok).toBe(false);
	});
});
