/**
 * The Python wheels installed into Pyodide — the single source of truth for
 * their versions and integrity pins.
 *
 * Every copy of these bytes is checked against `sha256` before use:
 * `scripts/fetch-wheels.ts` refuses a download that doesn't match, the engine
 * worker refuses to unpack one that doesn't match, and the Pyodide integration
 * test asserts the fetched files match. yt-dlp pins an exact yt-dlp-ejs version
 * (`yt-dlp-ejs==…; extra == "default"`), so the two always move together — use
 * `bun run update:ytdlp`, never edit one entry alone.
 *
 * This module is plain data on purpose: Bun scripts import it directly.
 */
export interface WheelPin {
	/** PyPI project name. */
	name: string;
	version: string;
	/** Wheel filename; also its path under `static/wheels/` and `.wheel-cache/`. */
	file: string;
	/** Canonical download URL (files.pythonhosted.org). */
	url: string;
	/** Lowercase hex SHA-256 of the wheel, as published by PyPI. */
	sha256: string;
	/** Size in bytes, for progress reporting. */
	size: number;
}

export const WHEELS: readonly WheelPin[] = [
	{
		name: 'yt-dlp',
		version: '2026.10.26',
		file: 'yt_dlp-2026.10.26-py3-none-any.whl',
		url: 'https://files.pythonhosted.org/packages/7f/3d/16ea7d5638cf585991f2c5705e8083688dde633d32d0871f2404e0f4d827/yt_dlp-2026.10.26-py3-none-any.whl',
		sha256: 'a05c5b5d8562f7e8a62f5334348b406af4930d56d3a65f8021d14af0e22339ae',
		size: 3186201
	},
	{
		name: 'yt-dlp-ejs',
		version: '0.8.0',
		file: 'yt_dlp_ejs-0.8.0-py3-none-any.whl',
		url: 'https://files.pythonhosted.org/packages/e3/bd/520769863744b669440a924271a6159ddd82ad5ae26b4ac4d4b69e9f8d44/yt_dlp_ejs-0.8.0-py3-none-any.whl',
		sha256: '79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4',
		size: 53443
	}
];

/** Raw bytes, typed without DOM-only names so Bun scripts and Workers can import this module. */
export type Bytes = ArrayBuffer | Uint8Array<ArrayBuffer>;

/** Lowercase hex SHA-256 of `bytes`, via WebCrypto (browser, Worker, Bun, Node). */
export async function sha256Hex(bytes: Bytes): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Throws unless `bytes` hash to the pinned SHA-256 of `pin`. */
export async function assertWheelIntegrity(pin: WheelPin, bytes: Bytes): Promise<void> {
	const actual = await sha256Hex(bytes);
	if (actual !== pin.sha256) {
		throw new Error(
			`Integrity check failed for ${pin.file}: expected sha256 ${pin.sha256}, got ${actual}`
		);
	}
}
