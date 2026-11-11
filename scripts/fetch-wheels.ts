/**
 * Download the pinned Python wheels into the gitignored `.wheel-cache/`.
 *
 * Idempotent: a cached wheel whose SHA-256 still matches its pin is kept, and
 * nothing is downloaded. Any mismatch — cached or freshly downloaded — is a
 * hard failure, never a silent re-use. Run by `bun run assets` (dev/build) and
 * at `Dockerfile.test` image build, so CI always has the real wheels.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WHEELS, assertWheelIntegrity, sha256Hex } from '../src/lib/engine/wheels.ts';
import { NO_RELAY } from '../src/lib/relay/protocol.ts';

export const WHEEL_CACHE = join(import.meta.dir, '..', '.wheel-cache');

export async function fetchWheels(cacheDir = WHEEL_CACHE): Promise<void> {
	await mkdir(cacheDir, { recursive: true });
	for (const pin of WHEELS) {
		const path = join(cacheDir, pin.file);
		const cached = Bun.file(path);
		if (await cached.exists()) {
			const actual = await sha256Hex(await cached.arrayBuffer());
			if (actual === pin.sha256) {
				console.log(`✓ ${pin.file} (cached)`);
				continue;
			}
			console.warn(`! ${pin.file}: cached copy does not match its pin — re-downloading`);
		}
		const response = await fetch(pin.url);
		if (!response.ok) {
			throw new Error(`Download failed for ${pin.file}: HTTP ${response.status}`);
		}
		const bytes = await response.arrayBuffer();
		await assertWheelIntegrity(pin, bytes);
		await Bun.write(path, bytes);
		console.log(`↓ ${pin.file} (${bytes.byteLength} bytes, sha256 verified)`);
	}
}

if (import.meta.main) {
	// A build without a relay never runs yt-dlp, so ships no wheels (sync-assets.ts).
	if (process.env.VITE_RELAY_URL === NO_RELAY)
		console.log('– no wheels needed (VITE_RELAY_URL=none)');
	else await fetchWheels();
}
