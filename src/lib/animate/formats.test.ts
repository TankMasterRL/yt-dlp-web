// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { FORMATS, FORMAT_ORDER } from './formats';

describe('animation formats', () => {
	it('lists every format once, GIF first', () => {
		expect(FORMAT_ORDER).toEqual(['gif', 'webp', 'apng', 'avif', 'jxl']);
		expect(Object.keys(FORMATS).sort()).toEqual([...FORMAT_ORDER].sort());
	});

	it('knows each one’s file type', () => {
		expect(FORMAT_ORDER.map((f) => [f, FORMATS[f].label, FORMATS[f].mime, FORMATS[f].ext])).toEqual(
			[
				['gif', 'GIF', 'image/gif', 'gif'],
				['webp', 'WebP', 'image/webp', 'webp'],
				['apng', 'APNG', 'image/png', 'png'],
				['avif', 'AVIF', 'image/avif', 'avif'],
				['jxl', 'JPEG XL', 'image/jxl', 'jxl']
			]
		);
	});

	it('types each file as its extension says, so a browser saving it keeps its name', () => {
		// Firefox renames a download whose type has other extensions: an APNG typed
		// image/apng and named .png was saved as .apng.
		for (const format of FORMAT_ORDER) {
			expect(FORMATS[format].mime, format).toBe(`image/${FORMATS[format].ext}`);
		}
	});

	it('says which take a quality and which need a palette', () => {
		expect(FORMAT_ORDER.filter((f) => FORMATS[f].lossy)).toEqual(['webp', 'avif']);
		expect(FORMAT_ORDER.filter((f) => FORMATS[f].palette)).toEqual(['gif']);
	});
});
