import { describe, expect, it } from 'vitest';
import { WHEELS, assertWheelIntegrity, sha256Hex } from './wheels';

describe('wheel pins', () => {
	it('are well-formed and served from PyPI', () => {
		for (const pin of WHEELS) {
			expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(pin.size).toBeGreaterThan(0);
			// PEP 427: {distribution}-{version}-{python}-{abi}-{platform}.whl, '-' → '_'
			expect(pin.file).toBe(`${pin.name.replaceAll('-', '_')}-${pin.version}-py3-none-any.whl`);
			expect(new URL(pin.url).hostname).toBe('files.pythonhosted.org');
			expect(pin.url.endsWith(`/${pin.file}`)).toBe(true);
		}
	});

	it('pin yt-dlp and the yt-dlp-ejs it depends on, and nothing else', () => {
		expect(WHEELS.map((w) => w.name).sort()).toEqual(['yt-dlp', 'yt-dlp-ejs']);
	});
});

describe('integrity checks', () => {
	it('hashes with SHA-256', async () => {
		// FIPS 180-2 test vector.
		expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});

	it('rejects bytes that do not match the pin', async () => {
		const pin = WHEELS[0];
		await expect(assertWheelIntegrity(pin, new Uint8Array([1, 2, 3]))).rejects.toThrow(
			/Integrity check failed/
		);
	});
});
