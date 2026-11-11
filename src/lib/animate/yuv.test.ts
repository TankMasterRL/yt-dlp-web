// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { I420_CICP, I420_COLOR_SPACE, rgbaToI420 } from './yuv';

/** RGBA pixels from [r, g, b] triples, opaque. */
const rgba = (...pixels: [number, number, number][]) =>
	Uint8ClampedArray.from(pixels.flatMap((p) => [...p, 255]));

/** The planes of an I420 frame. */
function planes({ data, codedWidth, codedHeight }: ReturnType<typeof rgbaToI420>) {
	const ySize = codedWidth * codedHeight;
	const cSize = (codedWidth / 2) * (codedHeight / 2);
	return {
		y: [...data.subarray(0, ySize)],
		u: [...data.subarray(ySize, ySize + cSize)],
		v: [...data.subarray(ySize + cSize)]
	};
}

const solid = (rgb: [number, number, number]) => planes(rgbaToI420(rgba(rgb, rgb, rgb, rgb), 2, 2));

describe('rgbaToI420', () => {
	it('says what it converts with: BT.709, limited range, sRGB values as they are', () => {
		expect(I420_COLOR_SPACE).toEqual({
			primaries: 'bt709',
			transfer: 'iec61966-2-1',
			matrix: 'bt709',
			fullRange: false
		});
		// …and in the code points a stream and a colr box say it with.
		expect(I420_CICP).toEqual({ primaries: 1, transfer: 13, matrix: 1, fullRange: false });
	});

	it('puts white, black and the primaries where BT.709 limited range puts them', () => {
		// With R, G, B in 0-1: Y′ = .2126 R + .7152 G + .0722 B, then
		// Y = 16 + 219 Y′, Cb = 128 + 224 (B − Y′) / 1.8556, Cr = 128 + 224 (R − Y′) / 1.5748.
		expect(solid([255, 255, 255])).toEqual({ y: [235, 235, 235, 235], u: [128], v: [128] });
		expect(solid([0, 0, 0])).toEqual({ y: [16, 16, 16, 16], u: [128], v: [128] });
		// Red's Cr and blue's Cb are the top of the chroma range.
		expect(solid([255, 0, 0])).toEqual({ y: [63, 63, 63, 63], u: [102], v: [240] });
		expect(solid([0, 255, 0])).toEqual({ y: [173, 173, 173, 173], u: [42], v: [26] });
		expect(solid([0, 0, 255])).toEqual({ y: [32, 32, 32, 32], u: [240], v: [118] });
	});

	it('keeps every pixel’s luma, and gives each 2 × 2 block its mean colour', () => {
		// Red, white / black, blue: the mean is (.5, .25, .5), Y′ .3212.
		const frame = rgbaToI420(rgba([255, 0, 0], [255, 255, 255], [0, 0, 0], [0, 0, 255]), 2, 2);
		expect(planes(frame)).toEqual({ y: [63, 235, 16, 32], u: [150], v: [153] });
	});

	it('pads an odd size to even with its last column and row, which WebCodecs I420 needs', () => {
		const frame = rgbaToI420(rgba([255, 255, 255], [0, 0, 0], [255, 0, 0]), 3, 1);
		expect(frame).toMatchObject({ width: 3, height: 1, codedWidth: 4, codedHeight: 2 });
		expect(frame.data).toHaveLength(4 * 2 + 2 * (2 * 1));
		expect(planes(frame)).toEqual({
			y: [235, 16, 63, 63, 235, 16, 63, 63],
			// White and black make grey; red's block is red alone.
			u: [128, 102],
			v: [128, 240]
		});
	});

	it('wants a whole frame', () => {
		expect(() => rgbaToI420(new Uint8ClampedArray(4 * 3), 2, 2)).toThrow(RangeError);
	});
});
