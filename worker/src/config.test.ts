// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { hostMatches } from './policy';
import { DEFAULT_ALLOWED_HOSTS, parseOrigins, relayConfig } from './config';

describe('relay configuration', () => {
	it('defaults to the hosts YouTube extraction needs, and no foreign origins', () => {
		const config = relayConfig({});
		for (const host of [
			'www.youtube.com',
			'm.youtube.com',
			'youtu.be',
			'youtubei.googleapis.com',
			'rr3---sn-4g5ednsz.googlevideo.com',
			'i.ytimg.com',
			'yt3.ggpht.com'
		]) {
			expect(hostMatches(host, config.allowedHosts), host).toBe(true);
		}
		expect(hostMatches('googleapis.com', config.allowedHosts)).toBe(false);
		expect(hostMatches('www.google.com', config.allowedHosts)).toBe(false);
		expect(config.allowedOrigins.size).toBe(0);
		expect(config.maxBufferedBytes).toBe(32 * 1024 * 1024);
		expect(DEFAULT_ALLOWED_HOSTS).not.toContain('*,');
	});

	it('takes overrides from the environment', () => {
		const config = relayConfig({
			ALLOWED_HOSTS: '*.example.org',
			ALLOWED_ORIGINS: 'https://tankmasterrl.github.io, http://localhost:5173',
			MAX_BUFFERED_BYTES: '1024'
		});
		expect(hostMatches('media.example.org', config.allowedHosts)).toBe(true);
		expect(hostMatches('www.youtube.com', config.allowedHosts)).toBe(false);
		expect([...config.allowedOrigins]).toEqual([
			'https://tankmasterrl.github.io',
			'http://localhost:5173'
		]);
		expect(config.maxBufferedBytes).toBe(1024);
	});

	it.each(['*', 'null', 'https://app.example/', 'https://app.example/path', 'app.example'])(
		'refuses %j as an allowed origin',
		(origin) => {
			expect(() => parseOrigins(origin)).toThrow();
		}
	);

	it('refuses nonsense limits', () => {
		expect(() => relayConfig({ MAX_BUFFERED_BYTES: '-5' })).toThrow();
		expect(() => relayConfig({ MAX_REQUEST_BODY_BYTES: 'lots' })).toThrow();
	});
});
