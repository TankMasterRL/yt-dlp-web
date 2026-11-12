/**
 * Boot yt-dlp inside Pyodide. Shared by the engine worker (browser) and the
 * Pyodide integration test (Node): the only differences — where Pyodide and the
 * wheels come from, and which transport carries HTTP — are injected.
 */
import type { PyodideInterface } from 'pyodide';
import { PYTHON_SOURCES } from './python-sources';
import type { SyncTransport } from './transport';
import { WHEELS, assertWheelIntegrity, type WheelPin } from './wheels';

export interface BootOptions {
	/** Returns a fresh Pyodide instance (worker: from static/pyodide/; tests: node_modules). */
	loadPyodide: () => Promise<PyodideInterface>;
	/** Returns a pinned wheel's bytes (worker: fetch static/wheels/; tests: .wheel-cache/). */
	readWheel: (pin: WheelPin) => Promise<ArrayBuffer | Uint8Array>;
	/** Carries every yt-dlp HTTP request. */
	transport: SyncTransport;
	/**
	 * Runs a YouTube JS-challenge solver program and returns what it printed
	 * (the relay Worker's /solve). Omit, or resolve to undefined, when this
	 * deployment cannot solve. A promise (the relay's probe) holds up only
	 * installing yt-dlp: the runtime and the wheels load meanwhile.
	 */
	solver?: Solver | Promise<Solver | undefined>;
	onProgress?: (stage: BootStage) => void;
}

export type Solver = (program: string) => string;

export type BootStage = 'runtime' | 'wheels' | 'yt-dlp' | 'ready';

/** Metadata for one media format, as produced by yt-dlp's sanitize_info(). */
export interface FormatInfo {
	format_id: string;
	url: string;
	ext?: string;
	protocol?: string;
	vcodec?: string;
	acodec?: string;
	width?: number | null;
	height?: number | null;
	fps?: number | null;
	tbr?: number | null;
	filesize?: number | null;
	filesize_approx?: number | null;
	format_note?: string;
	format?: string;
	http_headers?: Record<string, string>;
	downloader_options?: { http_chunk_size?: number };
	[key: string]: unknown;
}

export interface VideoInfo extends Partial<FormatInfo> {
	id: string;
	title: string;
	webpage_url?: string;
	extractor?: string;
	extractor_key?: string;
	uploader?: string | null;
	duration?: number | null;
	thumbnail?: string | null;
	formats?: FormatInfo[];
	requested_formats?: FormatInfo[];
	entries?: VideoInfo[];
	[key: string]: unknown;
}

export type ExtractResult =
	| { ok: true; info: VideoInfo; warnings: string[] }
	| { ok: false; error: string; warnings: string[] };

export type LogLevel = 'info' | 'warning' | 'error';

export interface Engine {
	pyodide: PyodideInterface;
	/**
	 * Synchronous: blocks the calling (worker) thread while yt-dlp runs.
	 * `onLog` receives yt-dlp's progress lines as they happen.
	 */
	extract(
		url: string,
		options?: Record<string, unknown>,
		onLog?: (level: LogLevel, line: string) => void
	): ExtractResult;
	/**
	 * Does a first extraction's one-time work ahead of it, without the network:
	 * each call of the returned step runs one slice (tens of milliseconds) and
	 * says whether more remain. Synchronous, like `extract`.
	 */
	warmUp(): () => boolean;
}

/** Pyodide's proxy of a Python generator. */
interface PyGenerator {
	next(): IteratorResult<unknown>;
	destroy(): void;
}

export async function bootEngine(options: BootOptions): Promise<Engine> {
	const { onProgress = () => {} } = options;

	onProgress('runtime');
	// The wheels download and are checked while the runtime starts: neither waits
	// for the other. Each is unpacked only once the runtime is up, in pinned order.
	const wheels = WHEELS.map(async (pin) => {
		// Always a plain, ArrayBuffer-backed Uint8Array: Pyodide rejects Node's
		// Buffer subclass, and WebCrypto wants an ArrayBuffer (not a SharedArrayBuffer).
		const bytes = new Uint8Array(await options.readWheel(pin));
		await assertWheelIntegrity(pin, bytes);
		return bytes;
	});
	// Awaited below, after the runtime: until then a failure is not "unhandled",
	// and if the runtime fails too, its failure is the one reported.
	for (const wheel of wheels) wheel.catch(() => {});
	const pyodide = await options.loadPyodide();
	const sitePackages: string = pyodide.runPython('import site; site.getsitepackages()[0]');

	onProgress('wheels');
	for (const wheel of wheels) {
		pyodide.unpackArchive(await wheel, 'wheel', { extractDir: sitePackages });
	}
	for (const [path, source] of Object.entries(PYTHON_SOURCES)) {
		const target = `${sitePackages}/${path}`;
		pyodide.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
		pyodide.FS.writeFile(target, source, { encoding: 'utf8' });
	}

	onProgress('yt-dlp');
	const solver = await options.solver;
	pyodide.pyimport('ytdlp_web.bootstrap').install(options.transport, solver ?? null);
	const api = pyodide.pyimport('ytdlp_web.api');

	onProgress('ready');
	return {
		pyodide,
		extract(url, extractOptions = {}, onLog) {
			return JSON.parse(api.extract(url, JSON.stringify(extractOptions), onLog)) as ExtractResult;
		},
		warmUp() {
			const slices = api.warm_up() as PyGenerator;
			let done = false;
			return () => {
				if (done) return false;
				done = slices.next().done === true;
				if (done) slices.destroy();
				return !done;
			};
		}
	};
}
