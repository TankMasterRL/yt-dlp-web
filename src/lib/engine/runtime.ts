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
	 * (the relay Worker's /solve). Omit when this deployment cannot solve.
	 */
	solver?: (program: string) => string;
	onProgress?: (stage: BootStage) => void;
}

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
}

export async function bootEngine(options: BootOptions): Promise<Engine> {
	const { onProgress = () => {} } = options;

	onProgress('runtime');
	const pyodide = await options.loadPyodide();
	const sitePackages: string = pyodide.runPython('import site; site.getsitepackages()[0]');

	onProgress('wheels');
	for (const pin of WHEELS) {
		// Always a plain, ArrayBuffer-backed Uint8Array: Pyodide rejects Node's
		// Buffer subclass, and WebCrypto wants an ArrayBuffer (not a SharedArrayBuffer).
		const bytes = new Uint8Array(await options.readWheel(pin));
		await assertWheelIntegrity(pin, bytes);
		pyodide.unpackArchive(bytes, 'wheel', { extractDir: sitePackages });
	}
	for (const [path, source] of Object.entries(PYTHON_SOURCES)) {
		const target = `${sitePackages}/${path}`;
		pyodide.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
		pyodide.FS.writeFile(target, source, { encoding: 'utf8' });
	}

	onProgress('yt-dlp');
	pyodide.pyimport('ytdlp_web.bootstrap').install(options.transport, options.solver ?? null);
	const api = pyodide.pyimport('ytdlp_web.api');

	onProgress('ready');
	return {
		pyodide,
		extract(url, extractOptions = {}, onLog) {
			return JSON.parse(api.extract(url, JSON.stringify(extractOptions), onLog)) as ExtractResult;
		}
	};
}
