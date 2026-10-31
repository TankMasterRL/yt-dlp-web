/**
 * RGB to Y'CbCr 4:2:0 (I420), for the AV1 encoder: converted here so the
 * AVIF can say exactly how. Handed RGBA, a browser converts as it sees fit
 * and may not say so truly — Firefox converts with BT.601, limited range, and
 * reports BT.709 — so the file's colours would be read back wrong.
 *
 * BT.709 coefficients at full range, the canvas's sRGB values as they are
 * (transfer: sRGB), each 2 × 2 block's chroma its mean colour (centre
 * sited, as AVIF reads 4:2:0 by default).
 */

/** How rgbaToI420 converts: the frames' colour space, and the AVIF's `colr`. */
export const I420_COLOR_SPACE = {
	primaries: 'bt709',
	transfer: 'iec61966-2-1',
	matrix: 'bt709',
	fullRange: true
} as const satisfies VideoColorSpaceInit;

/** Colours as CICP code points (ITU-T H.273), with the range: what AV1 and AVIF's colr say. */
export interface Cicp {
	primaries: number;
	transfer: number;
	matrix: number;
	fullRange: boolean;
}

/** I420_COLOR_SPACE in CICP: BT.709 primaries (1), sRGB transfer (13), BT.709 matrix (1). */
export const I420_CICP: Cicp = { primaries: 1, transfer: 13, matrix: 1, fullRange: true };

export interface I420Frame {
	/** The Y plane, then Cb and Cr at half the coded size each way. */
	data: Uint8Array;
	/** The picture's size. */
	width: number;
	height: number;
	/** Rounded up to even, as WebCodecs needs for I420; the padding repeats the last column and row. */
	codedWidth: number;
	codedHeight: number;
}

const KR = 0.2126;
const KB = 0.0722;
const KG = 1 - KR - KB;

const byte = (v: number) => Math.min(255, Math.max(0, Math.round(v)));

export function rgbaToI420(rgba: Uint8ClampedArray, width: number, height: number): I420Frame {
	if (rgba.length !== width * height * 4) {
		throw new RangeError(
			`expected a ${width} × ${height} frame (${width * height * 4} bytes), got ${rgba.length} bytes`
		);
	}
	const codedWidth = width + (width % 2);
	const codedHeight = height + (height % 2);
	const [cw, ch] = [codedWidth / 2, codedHeight / 2];
	const data = new Uint8Array(codedWidth * codedHeight + 2 * cw * ch);
	const cb = codedWidth * codedHeight;
	const cr = cb + cw * ch;
	/** The pixel at (x, y), the padding taking the last column's and row's. */
	const at = (x: number, y: number) =>
		(Math.min(y, height - 1) * width + Math.min(x, width - 1)) * 4;
	for (let y = 0; y < codedHeight; y++) {
		for (let x = 0; x < codedWidth; x++) {
			const p = at(x, y);
			data[y * codedWidth + x] = byte(KR * rgba[p] + KG * rgba[p + 1] + KB * rgba[p + 2]);
		}
	}
	for (let y = 0; y < ch; y++) {
		for (let x = 0; x < cw; x++) {
			const [p0, p1] = [at(2 * x, 2 * y), at(2 * x + 1, 2 * y)];
			const [p2, p3] = [at(2 * x, 2 * y + 1), at(2 * x + 1, 2 * y + 1)];
			const r = (rgba[p0] + rgba[p1] + rgba[p2] + rgba[p3]) / 4;
			const g = (rgba[p0 + 1] + rgba[p1 + 1] + rgba[p2 + 1] + rgba[p3 + 1]) / 4;
			const b = (rgba[p0 + 2] + rgba[p1 + 2] + rgba[p2 + 2] + rgba[p3 + 2]) / 4;
			const luma = KR * r + KG * g + KB * b;
			data[cb + y * cw + x] = byte(128 + (b - luma) / (2 * (1 - KB)));
			data[cr + y * cw + x] = byte(128 + (r - luma) / (2 * (1 - KR)));
		}
	}
	return { data, width, height, codedWidth, codedHeight };
}
