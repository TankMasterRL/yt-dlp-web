import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	BUILD_INFO_FILE,
	CONFIGURE_FLAGS,
	CORE_FILES,
	EMSCRIPTEN_VERSION,
	FFMPEG_COMMIT,
	LINK_FLAGS,
	buildStamp,
	emccVersion,
	readBuildInfo
} from './build-ffmpeg';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe("the remux core's FFmpeg", () => {
	it('is a pinned commit, built with a pinned Emscripten', () => {
		expect(FFMPEG_COMMIT).toMatch(/^[0-9a-f]{40}$/);
		expect(EMSCRIPTEN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it('is built in CI with the same Emscripten (Dockerfile.test)', () => {
		expect(source('Dockerfile.test')).toContain(
			`FROM emscripten/emsdk:${EMSCRIPTEN_VERSION} AS remux-core`
		);
	});

	it('enables every demuxer, muxer, parser and bitstream filter, the file protocol, and nothing else', () => {
		const everything = CONFIGURE_FLAGS.indexOf('--disable-everything');
		expect(everything).toBeGreaterThan(-1);
		const enabled = CONFIGURE_FLAGS.filter((flag) => flag.startsWith('--enable-'));
		expect(enabled).toEqual([
			'--enable-cross-compile',
			'--enable-small',
			'--enable-demuxers',
			'--enable-muxers',
			'--enable-parsers',
			'--enable-bsfs',
			'--enable-protocol=file'
		]);
		for (const components of ['demuxers', 'muxers', 'parsers', 'bsfs'])
			expect(CONFIGURE_FLAGS.indexOf(`--enable-${components}`)).toBeGreaterThan(everything);
	});

	it('stays LGPL: nothing GPL, v3-only or nonfree, and no external library', () => {
		for (const flag of ['--enable-gpl', '--enable-version3', '--enable-nonfree'])
			expect(CONFIGURE_FLAGS).not.toContain(flag);
		expect(CONFIGURE_FLAGS).toContain('--disable-autodetect');
		expect(CONFIGURE_FLAGS.filter((flag) => /^--enable-lib/.test(flag))).toEqual([]);
	});

	it('runs on one thread, with no network and no encoders, decoders or filters', () => {
		for (const flag of [
			'--disable-pthreads',
			'--disable-network',
			'--disable-avfilter',
			'--disable-avdevice',
			'--disable-swscale',
			'--disable-swresample',
			'--disable-programs'
		])
			expect(CONFIGURE_FLAGS).toContain(flag);
	});
});

describe("the remux core's link", () => {
	it('makes an ES module for a worker that needs no SharedArrayBuffer and no eval', () => {
		expect(LINK_FLAGS).toEqual(
			expect.arrayContaining(['-sENVIRONMENT=worker', '-sEXPORT_ES6', '-sDYNAMIC_EXECUTION=0'])
		);
		expect(LINK_FLAGS).toContain('-sEXPORT_NAME=createFFmpegCore');
		expect(LINK_FLAGS.some((flag) => /pthread|SHARED_MEMORY|WASM_WORKERS/.test(flag))).toBe(false);
	});

	it('exports what ffmpeg/pre.js calls, and remux.c defines the entry point', () => {
		const list = (setting: string) =>
			LINK_FLAGS.find((flag) => flag.startsWith(`-s${setting}=`))!
				.split('=')[1]
				.split(',');
		const glue = source('ffmpeg/pre.js');
		for (const name of list('EXPORTED_FUNCTIONS')) expect(glue).toContain(name);
		for (const name of ['_remux_exec', '_malloc', '_free'])
			expect(list('EXPORTED_FUNCTIONS')).toContain(name);
		for (const name of ['stringToNewUTF8', 'HEAPU32']) {
			expect(glue).toContain(name);
			expect(list('EXPORTED_RUNTIME_METHODS')).toContain(name);
		}
		// The remux worker's filesystem (handle-fs.ts) needs FS itself.
		expect(list('EXPORTED_RUNTIME_METHODS')).toContain('FS');
		// Read from createFFmpegCore()'s argument: pre.js's hooks, and the wasm handed over in Node.
		for (const name of ['print', 'printErr']) expect(glue).toContain(`Module['${name}']`);
		expect(list('INCOMING_MODULE_JS_API')).toEqual(
			expect.arrayContaining(['print', 'printErr', 'wasmBinary'])
		);
		expect(source('ffmpeg/remux.c')).toMatch(
			/EMSCRIPTEN_KEEPALIVE int remux_exec\(int argc, char \*\*argv\)/
		);
	});
});

describe('emccVersion', () => {
	it("reads the release from emcc's version banner", () => {
		expect(
			emccVersion(
				'emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.10 (d6c521a7f05449857c76bd99e396895583cf2083)\nCopyright (C) 2026 the Emscripten authors'
			)
		).toBe('6.0.10');
		expect(emccVersion('clang version 22.1.8')).toBeNull();
	});
});

describe('buildStamp', () => {
	const sources = { 'ffmpeg/remux.c': 'int main;', 'ffmpeg/pre.js': '// glue' };

	it('is the same for the same inputs, in any order', () => {
		expect(buildStamp(FFMPEG_COMMIT, sources)).toBe(
			buildStamp(FFMPEG_COMMIT, { 'ffmpeg/pre.js': '// glue', 'ffmpeg/remux.c': 'int main;' })
		);
	});

	it('changes with the FFmpeg commit or any source', () => {
		const stamp = buildStamp(FFMPEG_COMMIT, sources);
		expect(buildStamp('0'.repeat(40), sources)).not.toBe(stamp);
		expect(buildStamp(FFMPEG_COMMIT, { ...sources, 'ffmpeg/pre.js': '// other glue' })).not.toBe(
			stamp
		);
	});
});

describe('readBuildInfo', () => {
	let dist: string;
	afterEach(() => rmSync(dist, { recursive: true, force: true }));

	it('reports a build only when the core and its record are all there', () => {
		dist = mkdtempSync(join(tmpdir(), 'remux-core-'));
		expect(readBuildInfo(dist)).toBeNull();
		writeFileSync(join(dist, BUILD_INFO_FILE), JSON.stringify({ stamp: 'x' }));
		expect(readBuildInfo(dist)).toBeNull();
		for (const file of CORE_FILES) writeFileSync(join(dist, file), '');
		expect(readBuildInfo(dist)).toEqual({ stamp: 'x' });
	});
});
