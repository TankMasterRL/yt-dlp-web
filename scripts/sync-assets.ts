/**
 * Copy the runtime assets the app serves same-origin into `static/`:
 *
 *   node_modules/pyodide/{pyodide.mjs,…}        →  static/pyodide/
 *   .wheel-cache/*.whl                           →  static/wheels/
 *   node_modules/@ffmpeg/core/dist/esm/*         →  static/ffmpeg/  (+ NOTICE.txt)
 *
 * All destinations are gitignored build artifacts. Serving them from our own
 * origin keeps CSP `connect-src`/`script-src` at 'self' and means no CDN or PyPI
 * is contacted at runtime. Run after `fetch-wheels.ts` (see `bun run assets`).
 *
 * ffmpeg.wasm (merging separate video and audio) is opt-out: YT_DLP_WEB_FFMPEG=0
 * leaves it out of the build — for hosts that cap file sizes below its ~31 MiB
 * wasm (Workers Static Assets: 25 MiB), or to avoid shipping GPL code. The app
 * then offers no merging.
 */
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WHEELS } from '../src/lib/engine/wheels.ts';
import { FFMPEG_CORE_JS, FFMPEG_CORE_WASM, FFMPEG_DIR } from '../src/lib/remux/assets.ts';

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

async function copyAll(files: readonly string[], from: string, to: string): Promise<void> {
	await mkdir(to, { recursive: true });
	for (const file of files) {
		const source = join(from, file);
		if (!(await Bun.file(source).exists())) {
			throw new Error(`Missing ${source} — run \`bun install\` / \`bun run fetch:wheels\` first`);
		}
		await copyFile(source, join(to, file));
	}
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
	if (process.env.YT_DLP_WEB_FFMPEG === '0') {
		console.log(
			'– left ffmpeg.wasm out (YT_DLP_WEB_FFMPEG=0): this build cannot merge video and audio'
		);
	} else {
		const pkg = join(root, 'node_modules', '@ffmpeg', 'core');
		const { version } = (await Bun.file(join(pkg, 'package.json')).json()) as { version: string };
		const tag = FFMPEG_SOURCE_TAGS[version];
		if (!tag)
			throw new Error(
				`Add the ffmpeg.wasm source tag for @ffmpeg/core ${version} to FFMPEG_SOURCE_TAGS`
			);
		await copyAll(FFMPEG_CORE_FILES, join(pkg, 'dist', 'esm'), ffmpegTarget);
		await writeFile(join(ffmpegTarget, 'NOTICE.txt'), ffmpegNotice(version, tag));
		console.log(`✓ synced ffmpeg.wasm ${version} into static/${FFMPEG_DIR}`);
	}
}
