// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PaletteMapper, buildPalette } from './quantize';

/** RGBA pixels from RGB triples. */
function pixels(...rgb: [number, number, number][]): Uint8ClampedArray {
	return new Uint8ClampedArray(rgb.flatMap(([r, g, b]) => [r, g, b, 255]));
}

function colorsOf(palette: Uint8Array): string[] {
	const out: string[] = [];
	for (let i = 0; i < palette.length; i += 3) out.push(palette.slice(i, i + 3).join(','));
	return out.sort();
}

/** A width × height frame shading red across and green down: every pixel a different color. */
function gradient(width: number, height: number): Uint8ClampedArray {
	const out = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * 4;
			out.set([(x * 255) / (width - 1), (y * 255) / (height - 1), 96, 255], at);
		}
	}
	return out;
}

/** Mean absolute error per channel between RGBA pixels and the palette colors they map to. */
function meanError(rgba: Uint8ClampedArray, palette: Uint8Array, indices: Uint8Array): number {
	let sum = 0;
	for (let i = 0; i < indices.length; i++) {
		for (let c = 0; c < 3; c++) sum += Math.abs(rgba[i * 4 + c] - palette[indices[i] * 3 + c]);
	}
	return sum / (indices.length * 3);
}

describe('buildPalette', () => {
	it('keeps every color exactly when there are few enough', () => {
		const frame = pixels([255, 0, 0], [0, 255, 0], [255, 0, 0], [12, 34, 56]);
		const palette = buildPalette([frame, pixels([0, 0, 255])]);
		expect(palette.exact).toBe(true);
		expect(colorsOf(palette.colors)).toEqual(['0,0,255', '0,255,0', '12,34,56', '255,0,0']);
	});

	it('reduces many colors to at most the limit, and close to the originals', () => {
		const frame = gradient(256, 256);
		const palette = buildPalette([frame], 255);
		expect(palette.exact).toBe(false);
		expect(palette.colors.length / 3).toBeLessThanOrEqual(255);
		expect(palette.colors.length / 3).toBeGreaterThan(200);
		const indices = new Uint8Array(256 * 256);
		new PaletteMapper(palette.colors).map(frame, 256, indices, false);
		expect(meanError(frame, palette.colors, indices)).toBeLessThan(6);
	});

	it('spends colors where the pixels are', () => {
		// Mostly blue sky, a little of everything else.
		const sky = Array.from({ length: 900 }, (_, i): [number, number, number] => [
			40,
			90 + (i % 30),
			200 + (i % 50)
		]);
		const rest = Array.from({ length: 100 }, (_, i): [number, number, number] => [
			(i * 37) % 256,
			(i * 91) % 256,
			(i * 53) % 256
		]);
		const frame = pixels(...sky, ...rest);
		const palette = buildPalette([frame], 16);
		const indices = new Uint8Array(1000);
		new PaletteMapper(palette.colors).map(frame, 1000, indices, false);
		const skyOnly = frame.subarray(0, 900 * 4);
		expect(meanError(skyOnly, palette.colors, indices.subarray(0, 900))).toBeLessThan(6);
	});

	it('gives a picture of subtle shades as many colors as it needs', () => {
		// A sky: 1600 colors within 40 levels of each other, too fine for 5-bit bins.
		const frame = new Uint8ClampedArray(40 * 40 * 4);
		for (let y = 0; y < 40; y++) {
			for (let x = 0; x < 40; x++) frame.set([110 + x, 150 + y, 210, 255], (y * 40 + x) * 4);
		}
		const palette = buildPalette([frame]);
		expect(palette.colors.length / 3).toBe(255);
		const indices = new Uint8Array(40 * 40);
		new PaletteMapper(palette.colors).map(frame, 40, indices, false);
		expect(meanError(frame, palette.colors, indices)).toBeLessThan(1.5);
	});

	it('gives an empty input one color', () => {
		expect(buildPalette([]).colors).toEqual(new Uint8Array([0, 0, 0]));
	});
});

describe('PaletteMapper', () => {
	it('maps each pixel to its nearest color', () => {
		const palette = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 0, 0]);
		const out = new Uint8Array(4);
		new PaletteMapper(palette).map(
			pixels([10, 10, 10], [250, 240, 245], [200, 30, 20], [0, 0, 0]),
			4,
			out,
			false
		);
		expect([...out]).toEqual([0, 1, 2, 0]);
	});

	it('tells apart palette colors only a level apart', () => {
		const frame = pixels([100, 100, 100], [101, 100, 100], [100, 100, 102], [101, 100, 100]);
		const palette = buildPalette([frame]);
		const out = new Uint8Array(4);
		new PaletteMapper(palette.colors).map(frame, 4, out, false);
		const shown = [...out].map((i) => [...palette.colors.subarray(i * 3, i * 3 + 3)]);
		expect(shown).toEqual([
			[100, 100, 100],
			[101, 100, 100],
			[100, 100, 102],
			[101, 100, 100]
		]);
	});

	it('dithers in a fixed pattern, so a still picture stays still', () => {
		const frame = gradient(64, 64);
		const palette = buildPalette([frame], 8);
		const mapper = new PaletteMapper(palette.colors);
		const [a, b] = [new Uint8Array(64 * 64), new Uint8Array(64 * 64)];
		mapper.map(frame, 64, a, true);
		mapper.map(frame, 64, b, true);
		expect(b).toEqual(a);
	});

	it('dithering mixes colors that are closer, on average, to the picture', () => {
		const frame = gradient(64, 64);
		const palette = buildPalette([frame], 8);
		const mapper = new PaletteMapper(palette.colors);
		const blockError = (indices: Uint8Array) => {
			// Compare 8×8 block averages: what the eye sees from a distance.
			let sum = 0;
			for (let by = 0; by < 64; by += 8) {
				for (let bx = 0; bx < 64; bx += 8) {
					for (let c = 0; c < 3; c++) {
						let source = 0;
						let shown = 0;
						for (let y = by; y < by + 8; y++) {
							for (let x = bx; x < bx + 8; x++) {
								source += frame[(y * 64 + x) * 4 + c];
								shown += palette.colors[indices[y * 64 + x] * 3 + c];
							}
						}
						sum += Math.abs(source - shown) / 64;
					}
				}
			}
			return sum;
		};
		const [plain, dithered] = [new Uint8Array(64 * 64), new Uint8Array(64 * 64)];
		mapper.map(frame, 64, plain, false);
		mapper.map(frame, 64, dithered, true);
		expect(blockError(dithered)).toBeLessThan(blockError(plain));
	});
});
