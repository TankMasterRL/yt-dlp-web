/**
 * Compile FFmpeg into the remux core: WebAssembly that copies streams from
 * one container into another and does nothing else, for the app to serve
 * instead of ffmpeg.wasm (`YT_DLP_WEB_FFMPEG=remux`).
 *
 *   bun run build:ffmpeg
 *
 * FFmpeg (github.com/FFmpeg/FFmpeg, master, pinned in FFMPEG_COMMIT) is
 * configured with every demuxer, muxer, parser and bitstream filter it has,
 * so any codec in any container it knows can be remuxed, plus the file
 * protocol. Nothing else is compiled: no decoders, encoders, filters, devices,
 * network, threads, assembly or external libraries (so no zlib: the rare
 * zlib-compressed headers, such as old QuickTime's cmov, are refused). Built
 * without its GPL parts, FFmpeg is LGPL-2.1-or-later.
 *
 * The ffmpeg program itself needs threads, and threads in WebAssembly need
 * SharedArrayBuffer, so the entry point is ffmpeg/remux.c: the stream-copy
 * subset of ffmpeg's command line, on one thread. ffmpeg/pre.js gives the core
 * the JavaScript interface the remux worker uses.
 *
 * Toolchain: Emscripten EMSCRIPTEN_VERSION. `emcc` on PATH is used when it is
 * that release (as in the emscripten/emsdk image); otherwise emsdk installs it
 * into .ffmpeg-build/emsdk, which needs git and python3. FFmpeg's build needs
 * a POSIX shell and make.
 *
 * Output (gitignored): .ffmpeg-build/dist/ffmpeg-core.{js,wasm}, and
 * build-info.json saying what was built, for the notice sync-assets ships. A
 * build whose inputs have not changed is kept. FFMPEG_REF=<branch|tag|commit>
 * builds another FFmpeg revision, e.g. FFMPEG_REF=master for the newest.
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Not import.meta.dir: tests import this module under Node.
const root = fileURLToPath(new URL('..', import.meta.url));

export const FFMPEG_BUILD_DIR = join(root, '.ffmpeg-build');
export const FFMPEG_DIST_DIR = join(FFMPEG_BUILD_DIR, 'dist');
export const BUILD_INFO_FILE = 'build-info.json';

export const FFMPEG_REPOSITORY = 'https://github.com/FFmpeg/FFmpeg';
/** FFmpeg's master branch on 2026-09-23. */
export const FFMPEG_COMMIT = 'dc52424419177fa2624a614d5edcfe69b53032d2';
export const EMSCRIPTEN_VERSION = '6.0.10';
const EMSDK_REPOSITORY = 'https://github.com/emscripten-core/emsdk';

/** The core's own sources, compiled into it. */
export const CORE_SOURCES = ['ffmpeg/remux.c', 'ffmpeg/pre.js'] as const;

/** FFmpeg's configure: everything remuxing needs, whatever the codec or container; nothing else. */
export const CONFIGURE_FLAGS: readonly string[] = [
	// WebAssembly, through Emscripten's compiler wrappers.
	'--target-os=none',
	'--arch=wasm',
	'--enable-cross-compile',
	'--cc=emcc',
	'--cxx=em++',
	'--ar=emar',
	'--ranlib=emranlib',
	'--nm=emnm',
	'--disable-asm',
	'--disable-runtime-cpudetect',
	// Size over speed (-Os, no long names): copying streams is bound by I/O.
	'--enable-small',
	// Nothing picked up from the build machine; the libraries only.
	'--disable-autodetect',
	'--disable-iconv',
	'--disable-programs',
	'--disable-doc',
	'--disable-debug',
	// One thread (no SharedArrayBuffer) and no sockets: local files only.
	'--disable-pthreads',
	'--disable-w32threads',
	'--disable-os2threads',
	'--disable-network',
	// libavformat, and of libavcodec what copying a stream uses.
	'--disable-avdevice',
	'--disable-avfilter',
	'--disable-swscale',
	'--disable-swresample',
	'--disable-everything',
	'--enable-demuxers',
	'--enable-muxers',
	'--enable-parsers',
	'--enable-bsfs',
	'--enable-protocol=file'
];

/** emcc: ffmpeg/remux.c and the libraries → an ES module for a dedicated worker. */
export const LINK_FLAGS: readonly string[] = [
	'-Oz',
	'-sENVIRONMENT=worker',
	'-sMODULARIZE',
	'-sEXPORT_ES6',
	'-sEXPORT_NAME=createFFmpegCore',
	// The remux worker mounts its own filesystem over OPFS (handle-fs.ts).
	'-sFORCE_FILESYSTEM',
	'-sALLOW_MEMORY_GROWTH',
	'-sSTACK_SIZE=1MB',
	'-sEXPORTED_FUNCTIONS=_remux_exec,_malloc,_free',
	'-sEXPORTED_RUNTIME_METHODS=FS,stringToNewUTF8,HEAPU32',
	// What it reads from createFFmpegCore()'s argument: pre.js's log hooks, and
	// the wasm's bytes or location (Node's fetch cannot read file: URLs).
	'-sINCOMING_MODULE_JS_API=print,printErr,wasmBinary,locateFile',
	// No eval or new Function: the worker's CSP has no 'unsafe-eval'.
	'-sDYNAMIC_EXECUTION=0'
];

export const CORE_FILES = ['ffmpeg-core.js', 'ffmpeg-core.wasm'] as const;

/** What build-info.json records: the notice names the source, the stamp decides rebuilds. */
export interface BuildInfo {
	ffmpeg: { repository: string; commit: string };
	emscripten: string;
	license: 'LGPL-2.1-or-later';
	configure: readonly string[];
	stamp: string;
}

/** "emcc (Emscripten gcc/clang-like replacement …) 6.0.10 (d6c521a…)" → "6.0.10". */
export function emccVersion(versionOutput: string): string | null {
	return versionOutput.match(/^emcc \(.*\) (\d+\.\d+\.\d+)\b/m)?.[1] ?? null;
}

/** Everything a core is built from: the same stamp means the same core. */
export function buildStamp(commit: string, sources: Record<string, string>): string {
	const hash = createHash('sha256');
	hash.update(JSON.stringify({ commit, EMSCRIPTEN_VERSION, CONFIGURE_FLAGS, LINK_FLAGS }));
	for (const [name, text] of Object.entries(sources).sort()) hash.update(`\0${name}\0${text}`);
	return hash.digest('hex');
}

export function readBuildInfo(dist = FFMPEG_DIST_DIR): BuildInfo | null {
	const path = join(dist, BUILD_INFO_FILE);
	if (!existsSync(path) || CORE_FILES.some((file) => !existsSync(join(dist, file)))) return null;
	return JSON.parse(readFileSync(path, 'utf8')) as BuildInfo;
}

function run(command: string, args: readonly string[], options: SpawnSyncOptions = {}): string {
	const result = spawnSync(command, args, {
		stdio: ['ignore', 'inherit', 'inherit'],
		encoding: 'utf8',
		...options
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`\`${command} ${args.join(' ')}\` failed (exit code ${result.status})`);
	}
	return typeof result.stdout === 'string' ? result.stdout : '';
}

const capture = (command: string, args: readonly string[], options: SpawnSyncOptions = {}) =>
	run(command, args, { ...options, stdio: ['ignore', 'pipe', 'inherit'] }).trim();

/** PATH with the pinned Emscripten: the one already on PATH, or emsdk's. */
function emscriptenPath(): string {
	const path = process.env.PATH ?? '';
	const onPath = spawnSync('emcc', ['--version'], { encoding: 'utf8' });
	if (onPath.status === 0 && emccVersion(onPath.stdout) === EMSCRIPTEN_VERSION) return path;

	const emsdk = join(FFMPEG_BUILD_DIR, 'emsdk');
	const emscripten = join(emsdk, 'upstream', 'emscripten');
	const installed = spawnSync(join(emscripten, 'emcc'), ['--version'], { encoding: 'utf8' });
	if (installed.status !== 0 || emccVersion(installed.stdout) !== EMSCRIPTEN_VERSION) {
		console.log(`↓ Emscripten ${EMSCRIPTEN_VERSION} into ${emsdk}`);
		rmSync(emsdk, { recursive: true, force: true });
		run('git', [
			'clone',
			'--quiet',
			'--depth=1',
			`--branch=${EMSCRIPTEN_VERSION}`,
			EMSDK_REPOSITORY,
			emsdk
		]);
		run(join(emsdk, 'emsdk'), ['install', EMSCRIPTEN_VERSION]);
		run(join(emsdk, 'emsdk'), ['activate', EMSCRIPTEN_VERSION], { stdio: 'ignore' });
	}
	return `${emscripten}${delimiter}${path}`;
}

/** Check out `ref` in .ffmpeg-build/src, fetching that commit alone; returns the commit. */
function checkoutFFmpeg(ref: string): string {
	const src = join(FFMPEG_BUILD_DIR, 'src');
	if (!existsSync(join(src, '.git'))) run('git', ['init', '--quiet', src]);
	const head = spawnSync('git', ['-C', src, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
		encoding: 'utf8'
	}).stdout?.trim();
	if (head !== ref) {
		console.log(`↓ FFmpeg ${ref} from ${FFMPEG_REPOSITORY}`);
		run('git', ['-C', src, 'fetch', '--quiet', '--depth=1', `${FFMPEG_REPOSITORY}.git`, ref]);
		run('git', ['-C', src, 'checkout', '--quiet', '--force', '--detach', 'FETCH_HEAD']);
	}
	return capture('git', ['-C', src, 'rev-parse', 'HEAD^{commit}']);
}

/** configure (again only when the source or the flags change), then make. */
function buildLibraries(commit: string, env: NodeJS.ProcessEnv): string {
	const build = join(FFMPEG_BUILD_DIR, 'build');
	const configured = join(build, '.configured');
	const wanted = JSON.stringify({ commit, EMSCRIPTEN_VERSION, CONFIGURE_FLAGS });
	if (!existsSync(configured) || readFileSync(configured, 'utf8') !== wanted) {
		rmSync(build, { recursive: true, force: true });
		mkdirSync(build, { recursive: true });
		console.log('⚙ configuring FFmpeg for remuxing only');
		try {
			// Its summary is long; on failure the reason is in ffbuild/config.log.
			capture(join(FFMPEG_BUILD_DIR, 'src', 'configure'), CONFIGURE_FLAGS, { cwd: build, env });
		} catch (error) {
			const log = join(build, 'ffbuild', 'config.log');
			if (existsSync(log))
				console.error(readFileSync(log, 'utf8').split('\n').slice(-40).join('\n'));
			throw error;
		}
		writeFileSync(configured, wanted);
	}
	console.log('⚙ compiling libavformat, libavcodec (parsers, bitstream filters) and libavutil');
	run('make', [`-j${availableParallelism()}`], {
		cwd: build,
		env,
		stdio: ['ignore', 'ignore', 'inherit']
	});
	return build;
}

function linkCore(build: string, env: NodeJS.ProcessEnv): void {
	rmSync(FFMPEG_DIST_DIR, { recursive: true, force: true });
	mkdirSync(FFMPEG_DIST_DIR, { recursive: true });
	console.log('⚙ linking the remux core');
	run(
		'emcc',
		[
			join(root, 'ffmpeg', 'remux.c'),
			// Public headers from the source, avconfig.h and friends from the build.
			`-I${build}`,
			`-I${join(FFMPEG_BUILD_DIR, 'src')}`,
			...['libavformat', 'libavcodec', 'libavutil'].map((lib) => join(build, lib, `${lib}.a`)),
			...LINK_FLAGS,
			'--pre-js',
			join(root, 'ffmpeg', 'pre.js'),
			'-o',
			join(FFMPEG_DIST_DIR, 'ffmpeg-core.js')
		],
		{ env }
	);
}

export function buildFFmpeg(ref = process.env.FFMPEG_REF || FFMPEG_COMMIT): BuildInfo {
	mkdirSync(FFMPEG_BUILD_DIR, { recursive: true });
	const commit = checkoutFFmpeg(ref);
	const sources = Object.fromEntries(
		CORE_SOURCES.map((file) => [file, readFileSync(join(root, file), 'utf8')])
	);
	const stamp = buildStamp(commit, sources);
	const built = readBuildInfo();
	if (built?.stamp === stamp) {
		console.log(`✓ the remux core for FFmpeg ${commit.slice(0, 12)} is up to date`);
		return built;
	}

	const env = { ...process.env, PATH: emscriptenPath() };
	linkCore(buildLibraries(commit, env), env);
	const info: BuildInfo = {
		ffmpeg: { repository: FFMPEG_REPOSITORY, commit },
		emscripten: EMSCRIPTEN_VERSION,
		license: 'LGPL-2.1-or-later',
		configure: CONFIGURE_FLAGS,
		stamp
	};
	writeFileSync(join(FFMPEG_DIST_DIR, BUILD_INFO_FILE), `${JSON.stringify(info, null, '\t')}\n`);
	const sizes = CORE_FILES.map(
		(file) => `${file} ${(statSync(join(FFMPEG_DIST_DIR, file)).size / 2 ** 20).toFixed(2)} MiB`
	);
	console.log(`✓ the remux core for FFmpeg ${commit.slice(0, 12)}: ${sizes.join(', ')}`);
	return info;
}

if (import.meta.main) buildFFmpeg();
