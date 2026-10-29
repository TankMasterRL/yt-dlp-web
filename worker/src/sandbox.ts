/**
 * The isolate /solve runs YouTube's untrusted player code in.
 *
 * The solver program (yt-dlp-ejs's lib + core scripts plus the player, exactly
 * as yt-dlp's EJS providers would pipe it to Deno) is loaded as its OWN module —
 * never spliced into ours. `capture.js` replaces `console` at startup; `main.js`
 * imports the program INSIDE the fetch handler, so it is evaluated per request:
 * under the request's CPU budget (`limits.cpuMs`) rather than the much shorter
 * startup limit, and in handler context, where any I/O it attempts reaches
 * `globalOutbound: null` and throws. (At global scope workerd refuses async I/O
 * outright — a second, independent wall.)
 *
 * The isolate also gets no bindings (`env: {}`) and no subrequests.
 */
export const SANDBOX_COMPATIBILITY_DATE = '2026-09-01';

export const CAPTURE_MODULE = `export const output = [];
const print = (...args) => { output.push(args.map(String).join(' ')); };
const ignore = () => {};
globalThis.console = { log: print, info: print, warn: ignore, error: ignore, debug: ignore, trace: ignore };
`;

export const MAIN_MODULE = `import { output } from './capture.js';
export default {
	async fetch() {
		output.length = 0;
		await import('./program.js');
		return new Response(output.join('\\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
	}
};
`;

export interface SandboxCode {
	compatibilityDate: string;
	mainModule: string;
	modules: Record<string, string>;
	env: Record<string, never>;
	globalOutbound: null;
	limits: { cpuMs: number; subRequests: number };
}

export function sandboxCode(program: string, cpuMs: number): SandboxCode {
	return {
		compatibilityDate: SANDBOX_COMPATIBILITY_DATE,
		mainModule: 'main.js',
		modules: { 'main.js': MAIN_MODULE, 'capture.js': CAPTURE_MODULE, 'program.js': program },
		env: {},
		globalOutbound: null,
		limits: { cpuMs, subRequests: 0 }
	};
}
