/**
 * Copy the runtime assets the app serves same-origin into `static/`:
 *
 *   node_modules/pyodide/{pyodide.mjs,…}        →  static/pyodide/
 *   .wheel-cache/*.whl                           →  static/wheels/
 *   an FFmpeg core (YT_DLP_WEB_FFMPEG)           →  static/ffmpeg/  (+ NOTICE.txt)
 *
 * All destinations are gitignored build artifacts. Serving them from our own
 * origin keeps CSP `connect-src`/`script-src` at 'self' and means no CDN or PyPI
 * is contacted at runtime. Run after `fetch-wheels.ts` (see `bun run assets`).
 *
 * The FFmpeg core merges separate video and audio. YT_DLP_WEB_FFMPEG picks it:
 * unset, ffmpeg.wasm (`@ffmpeg/core`: GPL-2.0-or-later, ~31 MiB of wasm);
 * `remux`, the remux core `bun run build:ffmpeg` compiles (LGPL-2.1-or-later,
 * ~2.5 MiB: it only copies streams); `0`, none — for hosts that cap file sizes
 * below ffmpeg.wasm's (Workers Static Assets: 25 MiB) unless the remux core is
 * built, or to ship no FFmpeg at all. The app then offers no merging.
 */
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WHEELS } from '../src/lib/engine/wheels.ts';
import { FFMPEG_CORE_JS, FFMPEG_CORE_WASM, FFMPEG_DIR } from '../src/lib/remux/assets.ts';
import { CORE_FILES, FFMPEG_DIST_DIR, readBuildInfo, type BuildInfo } from './build-ffmpeg.ts';

// Not import.meta.dir: tests import this module under Node.
const root = fileURLToPath(new URL('..', import.meta.url));

/** The files `loadPyodide({ indexURL })` fetches; nothing else is shipped. */
export const PYODIDE_RUNTIME_FILES = [
	'pyodide.mjs',
	'pyodide.asm.mjs',
	'pyodide.asm.wasm',
	'python_stdlib.zip',
	'pyodide-lock.json'
] as const;

export const FFMPEG_CORE_FILES = [FFMPEG_CORE_JS, FFMPEG_CORE_WASM] as const;

/**
 * Shipped next to the core: ffmpeg.wasm is GPL-2.0-or-later, so whoever serves
 * it must say so and point at the corresponding source.
 */
export function ffmpegNotice(version: string, sourceTag: string): string {
	return `ffmpeg-core.js and ffmpeg-core.wasm in this directory are @ffmpeg/core ${version}
(https://www.npmjs.com/package/@ffmpeg/core), the single-threaded WebAssembly
build of FFmpeg made by the ffmpeg.wasm project, unmodified.

License: GPL-2.0-or-later (FFmpeg built with GPL components, including x264).
See https://www.gnu.org/licenses/old-licenses/gpl-2.0.html

Corresponding source: https://github.com/ffmpegwasm/ffmpeg.wasm/tree/${sourceTag}
(the build recipe, which pins FFmpeg and every library compiled into the core).

yt-dlp-web loads this core only to merge separately downloaded video and audio
streams, in the browser, without re-encoding them.
`;
}

/** The ffmpeg.wasm git tag each @ffmpeg/core release was built from. */
export const FFMPEG_SOURCE_TAGS: Record<string, string> = { '0.12.10': 'v12.15' };

/**
 * Shipped next to the remux core: FFmpeg's libraries, linked into one
 * WebAssembly file, are LGPL-2.1-or-later, so whoever serves them must say so,
 * point at their source, and make relinking possible (the recipe and the
 * program that links them are yt-dlp-web's own source).
 */
export function remuxNotice(info: BuildInfo): string {
	return `ffmpeg-core.js and ffmpeg-core.wasm in this directory are yt-dlp-web's remux core:
FFmpeg's libraries (libavformat, libavcodec, libavutil), unmodified, compiled to
WebAssembly with Emscripten ${info.emscripten} and linked with a small program that
copies streams from one container into another. They hold every demuxer, muxer,
parser and bitstream filter of FFmpeg, and no decoder, encoder or filter.

License: LGPL-2.1-or-later (FFmpeg built without GPL or nonfree components).
See https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html
Emscripten's runtime and C library: MIT and NCSA
(https://github.com/emscripten-core/emscripten/blob/main/LICENSE).

Corresponding source:
- FFmpeg: ${info.ffmpeg.repository}/tree/${info.ffmpeg.commit}
  configured with: ${info.configure.join(' ')}
- the program, its JavaScript interface and the build recipe: ffmpeg/remux.c,
  ffmpeg/pre.js and scripts/build-ffmpeg.ts in yt-dlp-web
  (https://github.com/TankMasterRL/yt-dlp-web). \`bun run build:ffmpeg\` rebuilds
  the core, against a modified FFmpeg too.

yt-dlp-web loads this core only to merge separately downloaded video and audio
streams, in the browser, without re-encoding them.
`;
}

export type FFmpegChoice = 'ffmpeg.wasm' | 'remux' | 'none';

/** YT_DLP_WEB_FFMPEG: unset (or 1) ffmpeg.wasm, `remux` the remux core, `0` none. */
export function ffmpegChoice(value: string | undefined): FFmpegChoice {
	if (value === undefined || value === '' || value === '1') return 'ffmpeg.wasm';
	if (value === 'remux') return 'remux';
	if (value === '0') return 'none';
	throw new Error(`YT_DLP_WEB_FFMPEG must be unset, 1, remux or 0, not "${value}"`);
}

export interface FFmpegAssets {
	from: string;
	files: readonly string[];
	notice: string;
	/** For the build log. */
	label: string;
}

/** Where the chosen core's files come from, and the notice that goes with them. */
export function ffmpegAssets(
	choice: FFmpegChoice,
	{ remuxDist = FFMPEG_DIST_DIR }: { remuxDist?: string } = {}
): FFmpegAssets | null {
	if (choice === 'none') return null;
	if (choice === 'remux') {
		const info = readBuildInfo(remuxDist);
		if (!info)
			throw new Error('YT_DLP_WEB_FFMPEG=remux: build the remux core first (bun run build:ffmpeg)');
		return {
			from: remuxDist,
			files: CORE_FILES,
			notice: remuxNotice(info),
			label: `the remux core (FFmpeg ${info.ffmpeg.commit.slice(0, 12)})`
		};
	}
	const pkg = join(root, 'node_modules', '@ffmpeg', 'core');
	const { version } = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as {
		version: string;
	};
	const tag = FFMPEG_SOURCE_TAGS[version];
	if (!tag)
		throw new Error(
			`Add the ffmpeg.wasm source tag for @ffmpeg/core ${version} to FFMPEG_SOURCE_TAGS`
		);
	return {
		from: join(pkg, 'dist', 'esm'),
		files: FFMPEG_CORE_FILES,
		notice: ffmpegNotice(version, tag),
		label: `ffmpeg.wasm ${version}`
	};
}

/**
 * Make `to` hold exactly `files` from `from`. Whatever an earlier pin left
 * there (the previous yt-dlp wheel, say) would otherwise ship in the build.
 */
export async function copyAll(files: readonly string[], from: string, to: string): Promise<void> {
	for (const file of files) {
		const source = join(from, file);
		if (!existsSync(source)) {
			throw new Error(`Missing ${source} — run \`bun install\` / \`bun run fetch:wheels\` first`);
		}
	}
	await rm(to, { recursive: true, force: true });
	await mkdir(to, { recursive: true });
	for (const file of files) await copyFile(join(from, file), join(to, file));
}

if (import.meta.main) {
	await copyAll(
		PYODIDE_RUNTIME_FILES,
		join(root, 'node_modules', 'pyodide'),
		join(root, 'static', 'pyodide')
	);
	await copyAll(
		WHEELS.map((w) => w.file),
		join(root, '.wheel-cache'),
		join(root, 'static', 'wheels')
	);
	console.log(
		`✓ synced ${PYODIDE_RUNTIME_FILES.length} Pyodide files and ${WHEELS.length} wheels into static/`
	);

	const ffmpegTarget = join(root, 'static', FFMPEG_DIR);
	await rm(ffmpegTarget, { recursive: true, force: true });
	const ffmpeg = ffmpegAssets(ffmpegChoice(process.env.YT_DLP_WEB_FFMPEG));
	if (!ffmpeg) {
		console.log('– left FFmpeg out (YT_DLP_WEB_FFMPEG=0): this build cannot merge video and audio');
	} else {
		await copyAll(ffmpeg.files, ffmpeg.from, ffmpegTarget);
		await writeFile(join(ffmpegTarget, 'NOTICE.txt'), ffmpeg.notice);
		console.log(`✓ synced ${ffmpeg.label} into static/${FFMPEG_DIR}`);
	}
}
