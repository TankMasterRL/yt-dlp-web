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
	it('says what it converts with: BT.709, full range, sRGB values as they are', () => {
		expect(I420_COLOR_SPACE).toEqual({
			primaries: 'bt709',
			transfer: 'iec61966-2-1',
			matrix: 'bt709',
			fullRange: true
		});
		// …and in the code points a stream and a colr box say it with.
		expect(I420_CICP).toEqual({ primaries: 1, transfer: 13, matrix: 1, fullRange: true });
	});

	it('puts white, black and the primaries where BT.709 full range puts them', () => {
		// Y = .2126 R + .7152 G + .0722 B; Cb = 128 + (B − Y) / 1.8556; Cr = 128 + (R − Y) / 1.5748.
		expect(solid([255, 255, 255])).toEqual({ y: [255, 255, 255, 255], u: [128], v: [128] });
		expect(solid([0, 0, 0])).toEqual({ y: [0, 0, 0, 0], u: [128], v: [128] });
		// Red's Cr and blue's Cb are 255.5: the edge of the range, kept in it.
		expect(solid([255, 0, 0])).toEqual({ y: [54, 54, 54, 54], u: [99], v: [255] });
		expect(solid([0, 255, 0])).toEqual({ y: [182, 182, 182, 182], u: [30], v: [12] });
		expect(solid([0, 0, 255])).toEqual({ y: [18, 18, 18, 18], u: [255], v: [116] });
	});

	it('keeps every pixel’s luma, and gives each 2 × 2 block its mean colour', () => {
		// Red, white / black, blue: the mean is (127.5, 63.75, 127.5), Y 81.9.
		const frame = rgbaToI420(rgba([255, 0, 0], [255, 255, 255], [0, 0, 0], [0, 0, 255]), 2, 2);
		expect(planes(frame)).toEqual({ y: [54, 255, 0, 18], u: [153], v: [157] });
	});

	it('pads an odd size to even with its last column and row, which WebCodecs I420 needs', () => {
		const frame = rgbaToI420(rgba([255, 255, 255], [0, 0, 0], [255, 0, 0]), 3, 1);
		expect(frame).toMatchObject({ width: 3, height: 1, codedWidth: 4, codedHeight: 2 });
		expect(frame.data).toHaveLength(4 * 2 + 2 * (2 * 1));
		expect(planes(frame)).toEqual({
			y: [255, 0, 54, 54, 255, 0, 54, 54],
			// White and black make grey; red's block is red alone.
			u: [128, 99],
			v: [128, 255]
		});
	});

	it('wants a whole frame', () => {
		expect(() => rgbaToI420(new Uint8ClampedArray(4 * 3), 2, 2)).toThrow(RangeError);
	});
});
