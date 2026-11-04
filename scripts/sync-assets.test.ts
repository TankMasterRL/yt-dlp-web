import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FFMPEG_CORE_JS, FFMPEG_CORE_WASM } from '../src/lib/remux/assets';
import { BUILD_INFO_FILE, CORE_FILES, type BuildInfo } from './build-ffmpeg';
import {
	FFMPEG_SOURCE_TAGS,
	copyAll,
	ffmpegAssets,
	ffmpegChoice,
	ffmpegNotice,
	remuxNotice
} from './sync-assets';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
	dependencies: Record<string, string>;
};

describe('a synced asset directory', () => {
	let from: string;
	let to: string;
	beforeEach(() => {
		from = mkdtempSync(join(tmpdir(), 'assets-from-'));
		to = join(mkdtempSync(join(tmpdir(), 'assets-to-')), 'wheels');
	});
	afterEach(() => {
		rmSync(from, { recursive: true, force: true });
		rmSync(join(to, '..'), { recursive: true, force: true });
	});

	it('holds exactly the files it is given: what an earlier pin left there would ship in the build', async () => {
		writeFileSync(join(from, 'yt_dlp-new.whl'), 'new');
		mkdirSync(to);
		writeFileSync(join(to, 'yt_dlp-old.whl'), 'old');
		await copyAll(['yt_dlp-new.whl'], from, to);
		expect(readdirSync(to)).toEqual(['yt_dlp-new.whl']);
		expect(readFileSync(join(to, 'yt_dlp-new.whl'), 'utf8')).toBe('new');
	});

	it('refuses a missing source, and leaves the directory as it was', async () => {
		mkdirSync(to);
		writeFileSync(join(to, 'yt_dlp-old.whl'), 'old');
		await expect(copyAll(['yt_dlp-new.whl'], from, to)).rejects.toThrow(
			/Missing .*yt_dlp-new\.whl/
		);
		expect(readdirSync(to)).toEqual(['yt_dlp-old.whl']);
	});
});

describe('the ffmpeg.wasm the build ships', () => {
	const version = pkg.dependencies['@ffmpeg/core'];

	it('is pinned exactly, with the git tag its GPL source is published under', () => {
		expect(version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(FFMPEG_SOURCE_TAGS[version]).toBeDefined();
	});

	it('ships with a notice naming its license and where its source is', () => {
		const notice = ffmpegNotice(version, FFMPEG_SOURCE_TAGS[version]);
		expect(notice).toContain(`@ffmpeg/core ${version}`);
		expect(notice).toContain('GPL-2.0-or-later');
		expect(notice).toContain(
			`https://github.com/ffmpegwasm/ffmpeg.wasm/tree/${FFMPEG_SOURCE_TAGS[version]}`
		);
	});
});

describe('YT_DLP_WEB_FFMPEG', () => {
	it('picks ffmpeg.wasm by default, the remux core with "remux", and nothing with "0"', () => {
		expect(ffmpegChoice(undefined)).toBe('ffmpeg.wasm');
		expect(ffmpegChoice('')).toBe('ffmpeg.wasm');
		expect(ffmpegChoice('1')).toBe('ffmpeg.wasm');
		expect(ffmpegChoice('remux')).toBe('remux');
		expect(ffmpegChoice('0')).toBe('none');
	});

	it('refuses anything else instead of guessing', () => {
		expect(() => ffmpegChoice('remux-core')).toThrow(/YT_DLP_WEB_FFMPEG/);
	});
});

describe('the remux core the build ships (YT_DLP_WEB_FFMPEG=remux)', () => {
	const info: BuildInfo = {
		ffmpeg: {
			repository: 'https://github.com/FFmpeg/FFmpeg',
			commit: 'dc52424419177fa2624a614d5edcfe69b53032d2'
		},
		emscripten: '6.0.10',
		license: 'LGPL-2.1-or-later',
		configure: ['--disable-everything', '--enable-demuxers'],
		stamp: 'stamp'
	};
	let dist: string;
	beforeEach(() => {
		dist = mkdtempSync(join(tmpdir(), 'remux-core-'));
	});
	afterEach(() => rmSync(dist, { recursive: true, force: true }));

	it('has the file names the remux worker loads', () => {
		expect(CORE_FILES).toEqual([FFMPEG_CORE_JS, FFMPEG_CORE_WASM]);
	});

	it('ships with a notice naming its license, the FFmpeg commit and the recipe', () => {
		const notice = remuxNotice(info);
		expect(notice).toContain('LGPL-2.1-or-later');
		expect(notice).toContain(
			'https://github.com/FFmpeg/FFmpeg/tree/dc52424419177fa2624a614d5edcfe69b53032d2'
		);
		for (const recipe of ['ffmpeg/remux.c', 'ffmpeg/pre.js', 'scripts/build-ffmpeg.ts'])
			expect(notice).toContain(recipe);
		expect(notice).toContain('Emscripten 6.0.10');
		expect(notice).toContain('--disable-everything --enable-demuxers');
	});

	it('comes from the finished build, and is refused until there is one', () => {
		expect(() => ffmpegAssets('remux', { remuxDist: dist })).toThrow(/bun run build:ffmpeg/);
		writeFileSync(join(dist, BUILD_INFO_FILE), JSON.stringify(info));
		for (const file of CORE_FILES) writeFileSync(join(dist, file), '');
		expect(ffmpegAssets('remux', { remuxDist: dist })).toEqual({
			from: dist,
			files: CORE_FILES,
			notice: remuxNotice(info),
			label: 'the remux core (FFmpeg dc5242441917)'
		});
	});
});

describe('YT_DLP_WEB_FFMPEG=0', () => {
	it('ships no FFmpeg at all', () => {
		expect(ffmpegAssets('none')).toBeNull();
	});
});
