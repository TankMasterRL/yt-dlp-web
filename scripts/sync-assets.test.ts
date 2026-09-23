import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FFMPEG_SOURCE_TAGS, ffmpegNotice } from './sync-assets';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
	dependencies: Record<string, string>;
};

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
