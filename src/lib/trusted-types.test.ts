import { describe, expect, it } from 'vitest';
import { sameOriginScriptUrl } from './trusted-types';

describe('worker script URL policy', () => {
	const here = 'https://app.example/yt-dlp-web/';

	it('admits same-origin scripts, resolved to absolute URLs', () => {
		expect(sameOriginScriptUrl('/_app/immutable/workers/engine.js', here)).toBe(
			'https://app.example/_app/immutable/workers/engine.js'
		);
		expect(sameOriginScriptUrl('./x.js', here)).toBe('https://app.example/yt-dlp-web/x.js');
	});

	it.each([
		'https://evil.example/worker.js',
		'//evil.example/worker.js',
		'data:text/javascript,postMessage(1)',
		'blob:https://evil.example/uuid'
	])('refuses %s', (url) => {
		expect(() => sameOriginScriptUrl(url, here)).toThrow(/another origin/);
	});

	it('refuses runtime-minted blob: URLs even on this origin', () => {
		expect(() => sameOriginScriptUrl('blob:https://app.example/1234', here)).toThrow(/blob: URL/);
	});
});
