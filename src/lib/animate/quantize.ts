/**
 * Color quantization for GIF: a palette of at most 256 colors for a whole
 * animation, and the mapping of each pixel onto it.
 *
 * - The palette is a median cut over a histogram of the sample frames (5 bits
 *   per channel, finer for pictures of subtle shades). It always splits the box whose colors are furthest from
 *   their mean, so colors go where the picture has the most detail. A picture
 *   with few enough colors keeps them all, exactly.
 * - Mapping is ordered (Bayer) dithering: the same pixel at the same place
 *   always gets the same index, so what does not move in the video does not
 *   shimmer in the GIF, and the encoder can skip it from frame to frame.
 *   Error diffusion would carry changes across the whole frame.
 */

export interface Palette {
	/** RGB triples. */
	colors: Uint8Array;
	/** Whether every sampled color is in it as it is: then there is nothing to dither. */
	exact: boolean;
}

/** Up to `maxColors` (≤ 256) colors for the RGBA pixels of `frames`. */
export function buildPalette(frames: readonly ArrayLike<number>[], maxColors = 255): Palette {
	const exact = exactColors(frames, maxColors);
	if (exact) return { colors: exact, exact: true };

	// Coarse bins first; finer ones while too few are occupied to fill the
	// palette, as in a sky of subtle shades. Each step has at most 8× the bins.
	let entries = histogram(frames, 5);
	for (let bits = 6; entries.weight.length < maxColors && bits <= 8; bits++) {
		entries = histogram(frames, bits);
	}
	const { weight, channel } = entries;
	const n = weight.length;

	const order = Int32Array.from({ length: n }, (_, i) => i);
	const boxes = [box(order, 0, n, weight, channel)];
	while (boxes.length < maxColors) {
		let pick = -1;
		for (let i = 0; i < boxes.length; i++) {
			if (boxes[i].end - boxes[i].start > 1 && (pick < 0 || boxes[i].error > boxes[pick].error))
				pick = i;
		}
		if (pick < 0 || boxes[pick].error === 0) break;
		const target = boxes[pick];
		const axis = channel[target.axis];
		order.subarray(target.start, target.end).sort((a, b) => axis[a] - axis[b]);
		// The weighted median, leaving at least one entry on each side.
		let half = 0;
		let split = target.start + 1;
		for (let i = target.start; i < target.end - 1; i++) {
			half += weight[order[i]];
			split = i + 1;
			if (half >= target.weight / 2) break;
		}
		boxes.splice(
			pick,
			1,
			box(order, target.start, split, weight, channel),
			box(order, split, target.end, weight, channel)
		);
	}

	const colors = new Uint8Array(Math.max(1, boxes.length) * 3);
	boxes.forEach((b, i) => colors.set(b.mean.map(Math.round), i * 3));
	return { colors, exact: false };
}

interface Histogram {
	/** Pixels per occupied bin. */
	weight: Float64Array;
	/** Each bin's mean red, green and blue. */
	channel: Float64Array[];
}

/** The occupied bins of `frames` at `bits` bits per channel. */
function histogram(frames: readonly ArrayLike<number>[], bits: number): Histogram {
	const shift = 8 - bits;
	const bins = new Map<number, number>();
	const count: number[] = [];
	const sum: number[][] = [[], [], []];
	for (const frame of frames) {
		for (let i = 0; i < frame.length; i += 4) {
			const [r, g, b] = [frame[i], frame[i + 1], frame[i + 2]];
			const key = ((r >> shift) << (2 * bits)) | ((g >> shift) << bits) | (b >> shift);
			let bin = bins.get(key);
			if (bin === undefined) {
				bin = count.length;
				bins.set(key, bin);
				count.push(0);
				for (const s of sum) s.push(0);
			}
			count[bin]++;
			sum[0][bin] += r;
			sum[1][bin] += g;
			sum[2][bin] += b;
		}
	}
	return {
		weight: Float64Array.from(count),
		channel: sum.map((s) => Float64Array.from(s, (v, bin) => v / count[bin]))
	};
}

interface Box {
	start: number;
	end: number;
	weight: number;
	mean: number[];
	/** Weighted squared distance of its colors from their mean. */
	error: number;
	/** The channel with the widest spread, to split along. */
	axis: number;
}

function box(
	order: Int32Array,
	start: number,
	end: number,
	weight: Float64Array,
	channel: Float64Array[]
): Box {
	let total = 0;
	const s = [0, 0, 0];
	const s2 = [0, 0, 0];
	for (let i = start; i < end; i++) {
		const e = order[i];
		const w = weight[e];
		total += w;
		for (let c = 0; c < 3; c++) {
			s[c] += w * channel[c][e];
			s2[c] += w * channel[c][e] ** 2;
		}
	}
	const spread = s2.map((sq, c) => Math.max(0, sq - s[c] ** 2 / total));
	const axis = spread.indexOf(Math.max(...spread));
	return {
		start,
		end,
		weight: total,
		mean: s.map((v) => v / total),
		error: spread[0] + spread[1] + spread[2],
		axis
	};
}

/** The distinct colors of `frames`, or null when there are more than `max`. */
function exactColors(frames: readonly ArrayLike<number>[], max: number): Uint8Array | null {
	const seen = new Set<number>();
	for (const frame of frames) {
		for (let i = 0; i < frame.length; i += 4) {
			seen.add((frame[i] << 16) | (frame[i + 1] << 8) | frame[i + 2]);
			if (seen.size > max) return null;
		}
	}
	if (!seen.size) return new Uint8Array(3);
	const colors = new Uint8Array(seen.size * 3);
	[...seen].forEach((rgb, i) => colors.set([rgb >> 16, (rgb >> 8) & 255, rgb & 255], i * 3));
	return colors;
}

/** The 8×8 Bayer matrix, as thresholds in [-0.5, 0.5). */
const BAYER = (() => {
	const m = [0];
	for (let size = 1; size < 8; size *= 2) {
		const next: number[] = new Array(size * size * 4);
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const v = m[y * size + x] * 4;
				const row = 2 * size;
				next[y * row + x] = v;
				next[y * row + x + size] = v + 2;
				next[(y + size) * row + x] = v + 3;
				next[(y + size) * row + x + size] = v + 1;
			}
		}
		m.splice(0, m.length, ...next);
	}
	return Float64Array.from(m, (v) => (v + 0.5) / 64 - 0.5);
})();

/** Maps RGBA pixels onto a palette's indices. */
export class PaletteMapper {
	readonly #colors: Uint8Array;
	readonly #count: number;
	/** The palette's own colors (24-bit) → their index: those always map to themselves. */
	readonly #exact = new Map<number, number>();
	/** Nearest index per 6-bit-per-channel color, -1 until asked. */
	readonly #cache = new Int16Array(1 << 18).fill(-1);
	/** How far a pixel is nudged at most, either way: the palette's typical spacing. */
	readonly #amplitude: number;

	constructor(colors: Uint8Array) {
		this.#colors = colors;
		this.#count = colors.length / 3;
		for (let i = this.#count - 1; i >= 0; i--) {
			this.#exact.set((colors[i * 3] << 16) | (colors[i * 3 + 1] << 8) | colors[i * 3 + 2], i);
		}
		this.#amplitude = typicalSpacing(colors);
	}

	/** Writes the index of each of `rgba`'s pixels (rows `width` wide) to `out`. */
	map(rgba: ArrayLike<number>, width: number, out: Uint8Array, dither: boolean): void {
		const amplitude = dither ? this.#amplitude : 0;
		for (let i = 0, p = 0; p < out.length; i += 4, p++) {
			const offset = amplitude && amplitude * BAYER[((p / width) & 7) * 8 + ((p % width) & 7)];
			const r = clamp255(rgba[i] + offset);
			const g = clamp255(rgba[i + 1] + offset);
			const b = clamp255(rgba[i + 2] + offset);
			// Undithered, a color the palette holds is itself, however close its neighbours.
			const exact = amplitude ? undefined : this.#exact.get((r << 16) | (g << 8) | b);
			if (exact !== undefined) {
				out[p] = exact;
				continue;
			}
			const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
			let index = this.#cache[key];
			if (index < 0) index = this.#cache[key] = this.#nearest(r, g, b);
			out[p] = index;
		}
	}

	#nearest(r: number, g: number, b: number): number {
		const colors = this.#colors;
		let best = 0;
		let bestDistance = Infinity;
		for (let i = 0; i < this.#count; i++) {
			const dr = colors[i * 3] - r;
			const dg = colors[i * 3 + 1] - g;
			const db = colors[i * 3 + 2] - b;
			const distance = dr * dr + dg * dg + db * db;
			if (distance < bestDistance) {
				bestDistance = distance;
				best = i;
			}
		}
		return best;
	}
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** The median distance from each color to its nearest neighbour, kept within reason. */
function typicalSpacing(colors: Uint8Array): number {
	const n = colors.length / 3;
	if (n < 2) return 0;
	const nearest: number[] = [];
	for (let i = 0; i < n; i++) {
		let best = Infinity;
		for (let j = 0; j < n; j++) {
			if (i === j) continue;
			const d = Math.hypot(
				colors[i * 3] - colors[j * 3],
				colors[i * 3 + 1] - colors[j * 3 + 1],
				colors[i * 3 + 2] - colors[j * 3 + 2]
			);
			if (d < best) best = d;
		}
		nearest.push(best);
	}
	nearest.sort((a, b) => a - b);
	return Math.min(Math.max(nearest[n >> 1], 8), 48);
}
