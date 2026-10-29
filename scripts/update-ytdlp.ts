/**
 * Keep the pinned yt-dlp and yt-dlp-ejs wheels current — together, because
 * each yt-dlp release pins the exact yt-dlp-ejs it needs.
 *
 *   bun run update:ytdlp
 *     Rewrite the pins in src/lib/engine/wheels.ts to PyPI's latest yt-dlp and
 *     the yt-dlp-ejs it requires, then download both and verify their SHA-256.
 *
 *   bun scripts/update-ytdlp.ts --check
 *     Exit 1 when PyPI is ahead of the pins (the weekly check-ytdlp workflow).
 *
 * The digests come from PyPI's JSON API over HTTPS; fetch-wheels then refuses
 * any download that does not match them.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WHEELS, type WheelPin } from '../src/lib/engine/wheels.ts';

export interface PypiRelease {
	info: { version: string; requires_dist?: string[] | null };
	urls: {
		packagetype: string;
		filename: string;
		url: string;
		size: number;
		digests: { sha256: string };
	}[];
}

export function wheelPin(name: string, release: PypiRelease): WheelPin {
	const wheel = release.urls.find(
		(u) => u.packagetype === 'bdist_wheel' && u.filename.endsWith('-py3-none-any.whl')
	);
	if (!wheel) throw new Error(`${name} ${release.info.version} has no pure-Python wheel`);
	return {
		name,
		version: release.info.version,
		file: wheel.filename,
		url: wheel.url,
		sha256: wheel.digests.sha256,
		size: wheel.size
	};
}

/** The yt-dlp-ejs version a yt-dlp release pins (`yt-dlp-ejs==X; extra == "default"`). */
export function requiredEjsVersion(release: PypiRelease): string {
	for (const requirement of release.info.requires_dist ?? []) {
		const match = requirement.match(/^yt-dlp-ejs\s*==\s*([^;\s]+)/);
		if (match) return match[1];
	}
	throw new Error(`yt-dlp ${release.info.version} does not pin yt-dlp-ejs`);
}

export function outdated(
	pins: readonly WheelPin[],
	latest: { ytdlp: string; ejs: string }
): boolean {
	const version = (name: string) => pins.find((p) => p.name === name)?.version;
	return version('yt-dlp') !== latest.ytdlp || version('yt-dlp-ejs') !== latest.ejs;
}

function renderPin(pin: WheelPin): string {
	return [
		'\t{',
		`\t\tname: '${pin.name}',`,
		`\t\tversion: '${pin.version}',`,
		`\t\tfile: '${pin.file}',`,
		`\t\turl: '${pin.url}',`,
		`\t\tsha256: '${pin.sha256}',`,
		`\t\tsize: ${pin.size}`,
		'\t}'
	].join('\n');
}

/** wheels.ts with its WHEELS array replaced; everything else is left as it is. */
export function rewriteWheels(source: string, pins: readonly WheelPin[]): string {
	const start = source.indexOf('export const WHEELS');
	const end = source.indexOf('];', start);
	if (start < 0 || end < 0) throw new Error('wheels.ts: WHEELS array not found');
	const array = `export const WHEELS: readonly WheelPin[] = [\n${pins.map(renderPin).join(',\n')}\n`;
	return source.slice(0, start) + array + source.slice(end);
}

async function pypi(name: string, version?: string): Promise<PypiRelease> {
	const url = `https://pypi.org/pypi/${name}/${version ? `${version}/` : ''}json`;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	return (await response.json()) as PypiRelease;
}

if (import.meta.main) {
	const latest = await pypi('yt-dlp');
	const ejs = requiredEjsVersion(latest);
	const pinned = WHEELS.map((p) => `${p.name} ${p.version}`).join(', ');
	if (!outdated(WHEELS, { ytdlp: latest.info.version, ejs })) {
		console.log(`✓ up to date: ${pinned}`);
		process.exit(0);
	}
	if (process.argv.includes('--check')) {
		console.error(
			`yt-dlp ${latest.info.version} (with yt-dlp-ejs ${ejs}) is out; pinned: ${pinned}.\n` +
				'Run `bun run update:ytdlp`, then the full test suite, and commit src/lib/engine/wheels.ts.'
		);
		process.exit(1);
	}
	const pins = [wheelPin('yt-dlp', latest), wheelPin('yt-dlp-ejs', await pypi('yt-dlp-ejs', ejs))];
	const path = fileURLToPath(new URL('../src/lib/engine/wheels.ts', import.meta.url));
	await writeFile(path, rewriteWheels(await readFile(path, 'utf8'), pins));
	console.log(`✓ pinned ${pins.map((p) => `${p.name} ${p.version}`).join(', ')}`);
	// A fresh process, so fetch-wheels sees the new pins; it verifies every digest.
	const fetched = Bun.spawnSync(
		['bun', fileURLToPath(new URL('fetch-wheels.ts', import.meta.url))],
		{
			stdout: 'inherit',
			stderr: 'inherit'
		}
	);
	if (fetched.exitCode !== 0) process.exit(fetched.exitCode ?? 1);
	console.log('Next: `bun run test` and `bun run test:e2e`, then commit src/lib/engine/wheels.ts.');
}
