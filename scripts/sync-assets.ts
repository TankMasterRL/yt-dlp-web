/**
 * Copy the runtime assets the app serves same-origin into `static/`:
 *
 *   node_modules/pyodide/{pyodide.mjs,…}  →  static/pyodide/
 *   .wheel-cache/*.whl                     →  static/wheels/
 *
 * Both destinations are gitignored build artifacts. Serving them from our own
 * origin keeps CSP `connect-src`/`script-src` at 'self' and means no CDN or PyPI
 * is contacted at runtime. Run after `fetch-wheels.ts` (see `bun run assets`).
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WHEELS } from '../src/lib/engine/wheels.ts';

const root = join(import.meta.dir, '..');

/** The files `loadPyodide({ indexURL })` fetches; nothing else is shipped. */
export const PYODIDE_RUNTIME_FILES = [
	'pyodide.mjs',
	'pyodide.asm.mjs',
	'pyodide.asm.wasm',
	'python_stdlib.zip',
	'pyodide-lock.json'
] as const;

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
}
