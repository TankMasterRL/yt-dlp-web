import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WHEELS } from '../src/lib/engine/wheels';
import {
	outdated,
	requiredEjsVersion,
	rewriteWheels,
	wheelPin,
	type PypiRelease
} from './update-ytdlp';

const release = (version: string, requires: string[] = []): PypiRelease => ({
	info: { version, requires_dist: requires },
	urls: [
		{
			packagetype: 'sdist',
			filename: `yt_dlp-${version}.tar.gz`,
			url: `https://files.pythonhosted.org/x/yt_dlp-${version}.tar.gz`,
			size: 9,
			digests: { sha256: 'a'.repeat(64) }
		},
		{
			packagetype: 'bdist_wheel',
			filename: `yt_dlp-${version}-py3-none-any.whl`,
			url: `https://files.pythonhosted.org/x/yt_dlp-${version}-py3-none-any.whl`,
			size: 3_000_000,
			digests: { sha256: 'b'.repeat(64) }
		}
	]
});

describe('reading PyPI', () => {
	it("pins a release's pure-Python wheel, never its sdist", () => {
		expect(wheelPin('yt-dlp', release('2027.1.2'))).toEqual({
			name: 'yt-dlp',
			version: '2027.1.2',
			file: 'yt_dlp-2027.1.2-py3-none-any.whl',
			url: 'https://files.pythonhosted.org/x/yt_dlp-2027.1.2-py3-none-any.whl',
			sha256: 'b'.repeat(64),
			size: 3_000_000
		});
	});

	it('refuses a release without a pure-Python wheel', () => {
		const sdistOnly = release('2027.1.2');
		sdistOnly.urls = sdistOnly.urls.filter((u) => u.packagetype === 'sdist');
		expect(() => wheelPin('yt-dlp', sdistOnly)).toThrow(/no pure-Python wheel/);
	});

	it('reads the exact yt-dlp-ejs version a yt-dlp release requires', () => {
		const r = release('2027.1.2', [
			'brotli; implementation_name == "cpython" and extra == "default"',
			'yt-dlp-ejs==0.9.1; extra == "default"'
		]);
		expect(requiredEjsVersion(r)).toBe('0.9.1');
		expect(() => requiredEjsVersion(release('2027.1.2'))).toThrow(/does not pin yt-dlp-ejs/);
	});
});

describe('the pins', () => {
	it('know when PyPI is ahead of them', () => {
		expect(outdated(WHEELS, { ytdlp: WHEELS[0].version, ejs: WHEELS[1].version })).toBe(false);
		expect(outdated(WHEELS, { ytdlp: '2099.1.1', ejs: WHEELS[1].version })).toBe(true);
		expect(outdated(WHEELS, { ytdlp: WHEELS[0].version, ejs: '9.9.9' })).toBe(true);
	});

	it('rewrite wheels.ts in its own format, touching nothing but the pins', () => {
		const source = readFileSync(new URL('../src/lib/engine/wheels.ts', import.meta.url), 'utf8');
		expect(rewriteWheels(source, WHEELS)).toBe(source);

		const next = wheelPin('yt-dlp', release('2027.1.2'));
		const rewritten = rewriteWheels(source, [next, WHEELS[1]]);
		expect(rewritten).toContain("version: '2027.1.2'");
		expect(rewritten).toContain(`sha256: '${'b'.repeat(64)}'`);
		expect(rewritten).not.toContain(WHEELS[0].sha256);
		expect(rewritten.split('export const WHEELS')[0]).toBe(source.split('export const WHEELS')[0]);
		expect(rewritten.split('];')[1]).toBe(source.split('];')[1]);
	});
});
