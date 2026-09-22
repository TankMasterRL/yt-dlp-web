/**
 * Execute a /solve program through the Worker's real sandbox module wrapper
 * (worker/src/sandbox.ts) in a child Node process — a real V8, never this one,
 * because capture.js replaces the global console. Throws if the program throws.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxCode } from '../../worker/src/sandbox';

export function runInSandboxModules(program: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'yt-dlp-web-sandbox-'));
	try {
		writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
		for (const [name, source] of Object.entries(sandboxCode(program, 1000).modules)) {
			writeFileSync(join(dir, name), source);
		}
		writeFileSync(
			join(dir, 'run.js'),
			`import worker from './main.js';\nprocess.stdout.write(await (await worker.fetch()).text());\n`
		);
		return execFileSync(process.execPath, ['run.js'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
