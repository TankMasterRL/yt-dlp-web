// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeApng } from '../../../tests/helpers/apng';
import { sequenceHeaderObu } from '../../../tests/helpers/av1';
import { decodeGif } from '../../../tests/helpers/gif';
import { readAvif as readAvifStrictly } from '../../../tests/helpers/isobmff';
import { decodeJxl } from '../../../tests/helpers/jxl';
import { readAnimatedWebp } from '../../../tests/helpers/webp';
import { ApngEncoder } from './apng';
import { AvifEncoder, type Av1Encoder, type Av1Output } from './avif';
import { GifEncoder } from './gif';
import { JxlEncoder } from './jxl';
import { buildPalette } from './quantize';
import { SIGNATURE_BYTES, imageFormat, readImage } from './read';
import { WebpEncoder, type StillWebpEncoder } from './webp';

type RGB = [number, number, number];

/** A width × height RGBA frame of one color. */
function solid(width: number, height: number, [r, g, b]: RGB): Uint8ClampedArray {
	const out = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < out.length; i += 4) out.set([r, g, b, 255], i);
	return out;
}

const RED: RGB = [255, 0, 0];
const GREEN: RGB = [0, 255, 0];
const BLUE: RGB = [0, 0, 255];

function concat(parts: ArrayLike<number>[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
	return out;
}

const bytes = (text: string) => [...text].map((c) => c.charCodeAt(0));
const u32be = (n: number) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const u32le = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];

describe('imageFormat', () => {
	it("tells each format by its file's first bytes", async () => {
		const gif = new GifEncoder({ width: 2, height: 2, palette: buildPalette([solid(2, 2, RED)]) });
		gif.addFrame(solid(2, 2, RED), 10);
		const apng = new ApngEncoder({ width: 2, height: 2, fps: 10 });
		await apng.addFrame(solid(2, 2, RED));
		const jxl = new JxlEncoder({ width: 2, height: 2, fps: 10 });
		jxl.addFrame(solid(2, 2, RED));
		const starts = (chunks: ArrayLike<number>[]) => concat(chunks).subarray(0, SIGNATURE_BYTES);
		expect(imageFormat(starts(gif.finish()))).toBe('gif');
		expect(imageFormat(starts(await apng.finish()))).toBe('apng');
		expect(imageFormat(starts(jxl.finish()))).toBe('jxl');
		expect(imageFormat(Uint8Array.from([...bytes('RIFF'), 0, 0, 0, 0, ...bytes('WEBP')]))).toBe(
			'webp'
		);
		const ftyp = (...brands: string[]) =>
			Uint8Array.from([
				...u32be(8 + brands.length * 4 + 4),
				...bytes('ftyp'),
				...bytes(brands[0]),
				0,
				0,
				0,
				0,
				...brands.slice(1).flatMap(bytes)
			]);
		expect(imageFormat(ftyp('avif', 'mif1'))).toBe('avif');
		expect(imageFormat(ftyp('mif1', 'miaf', 'avis'))).toBe('avif');
		expect(imageFormat(ftyp('isom', 'mp41'))).toBeNull();
	});

	it('tells none in anything else', () => {
		const webm = readFileSync(
			new URL('../../../tests/fixtures/media/bbf-360.webm', import.meta.url)
		);
		expect(imageFormat(new Uint8Array(webm))).toBeNull();
		expect(imageFormat(new TextEncoder().encode('GIF8 is not enough'))).toBeNull();
		expect(imageFormat(new Uint8Array())).toBeNull();
	});
});

describe('readImage', () => {
	it('reads nothing from a file in none of the five formats', () => {
		const webm = readFileSync(
			new URL('../../../tests/fixtures/media/bbf-360.webm', import.meta.url)
		);
		expect(readImage(new Uint8Array(webm))).toBeNull();
		expect(readImage(new TextEncoder().encode('not an image at all'))).toBeNull();
		expect(readImage(new Uint8Array())).toBeNull();
	});

	describe('GIF', () => {
		function gif(frames: [RGB, number][], width = 12, height = 8): Uint8Array {
			const pixels = frames.map(([color]) => solid(width, height, color));
			const encoder = new GifEncoder({ width, height, palette: buildPalette(pixels) });
			frames.forEach(([, delay], i) => encoder.addFrame(pixels[i], delay));
			return concat(encoder.finish());
		}

		it('counts the frames the app makes, and how long they play', () => {
			// The third changes nothing: it folds into the second.
			const file = gif([
				[RED, 10],
				[GREEN, 20],
				[GREEN, 5],
				[BLUE, 30]
			]);
			expect(readImage(file)).toEqual({
				format: 'gif',
				animated: true,
				width: 12,
				height: 8,
				frames: 3,
				duration: 0.65
			});
			// As a decoder of its own reads it.
			const decoded = decodeGif(file);
			expect(decoded.frames).toHaveLength(3);
			expect(decoded.frames.reduce((n, f) => n + f.delay, 0)).toBe(65);
		});

		it('counts a delay under 2 cs as the 10 cs browsers show it for', () => {
			expect(
				readImage(
					gif([
						[RED, 0],
						[GREEN, 1],
						[BLUE, 2]
					])
				)
			).toMatchObject({ frames: 3, duration: 0.22 });
		});

		it('calls one frame a still', () => {
			expect(readImage(gif([[RED, 50]], 3, 5))).toEqual({
				format: 'gif',
				animated: false,
				width: 3,
				height: 5,
				frames: 1,
				duration: null
			});
		});

		it('counts the whole frames of a file cut short, or ending in what no decoder reads', () => {
			const file = gif([
				[RED, 10],
				[GREEN, 10],
				[BLUE, 10]
			]);
			// Without its trailer, and with half of its last frame gone.
			expect(readImage(file.subarray(0, -1))).toMatchObject({ frames: 3, duration: 0.3 });
			const lastFrame = file.lastIndexOf(0x2c);
			expect(readImage(file.subarray(0, lastFrame + 14))).toMatchObject({
				frames: 2,
				duration: 0.2
			});
			const junk = concat([file.subarray(0, lastFrame), [0x99, 1, 2, 3]]);
			expect(readImage(junk)).toMatchObject({ frames: 2 });
			// No whole frame at all: there is nothing to count.
			expect(readImage(file.subarray(0, file.indexOf(0x2c) + 5))).toMatchObject({
				frames: null,
				duration: null
			});
		});

		it('reads GIF87a too', () => {
			const file = gif([[RED, 10]], 7, 9);
			file.set(bytes('GIF87a'));
			expect(readImage(file)).toMatchObject({ format: 'gif', width: 7, height: 9, frames: 1 });
		});
	});

	describe('PNG', () => {
		async function apng(frames: RGB[], fps: number, width = 6, height = 4) {
			const encoder = new ApngEncoder({ width, height, fps });
			for (const color of frames) await encoder.addFrame(solid(width, height, color));
			return concat(await encoder.finish());
		}

		function chunk(type: string, data: number[]): number[] {
			// The reader checks no CRCs: a decoder's job, not a header's.
			return [...u32be(data.length), ...bytes(type), ...data, 0, 0, 0, 0];
		}

		const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		const ihdr = (width: number, height: number) =>
			chunk('IHDR', [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]);
		const fctl = (num: number, den: number) =>
			chunk('fcTL', [...Array(20).fill(0), num >> 8, num & 255, den >> 8, den & 255, 0, 0]);

		it('counts the frames of an APNG the app makes, and how long they play', async () => {
			// At 10 fps; the repeated frame lengthens the one before.
			const file = await apng([RED, GREEN, GREEN, BLUE], 10);
			expect(readImage(file)).toEqual({
				format: 'apng',
				animated: true,
				width: 6,
				height: 4,
				frames: 3,
				duration: 0.4
			});
			const decoded = decodeApng(file);
			expect(decoded.frames).toHaveLength(3);
		});

		it('calls a PNG without an animation control chunk before its data a still', () => {
			const still = concat([SIGNATURE, ihdr(32, 16), chunk('IDAT', [1, 2, 3]), chunk('IEND', [])]);
			expect(readImage(still)).toEqual({
				format: 'apng',
				animated: false,
				width: 32,
				height: 16,
				frames: 1,
				duration: null
			});
			// An acTL after the image data is not one decoders follow.
			const late = concat([
				SIGNATURE,
				ihdr(32, 16),
				chunk('IDAT', [1, 2, 3]),
				chunk('acTL', [...u32be(2), ...u32be(0)]),
				fctl(1, 10),
				fctl(1, 10),
				chunk('IEND', [])
			]);
			expect(readImage(late)).toMatchObject({ animated: false, frames: 1 });
		});

		it('reads a delay denominator of 0 as hundredths', () => {
			const file = concat([
				SIGNATURE,
				ihdr(2, 2),
				chunk('acTL', [...u32be(2), ...u32be(0)]),
				fctl(25, 0),
				chunk('IDAT', [1]),
				fctl(3, 4),
				chunk('fdAT', [0, 0, 0, 2, 1]),
				chunk('IEND', [])
			]);
			expect(readImage(file)).toMatchObject({ animated: true, frames: 2, duration: 1 });
		});

		it('refuses a PNG without a size', () => {
			expect(readImage(concat([SIGNATURE, chunk('IEND', [])]))).toBeNull();
		});
	});

	describe('WebP', () => {
		function chunk(type: string, data: number[]): number[] {
			return [...bytes(type), ...u32le(data.length), ...data, ...(data.length % 2 ? [0] : [])];
		}

		const riff = (...chunks: number[][]) => {
			const body = chunks.flat();
			return Uint8Array.from([
				...bytes('RIFF'),
				...u32le(4 + body.length),
				...bytes('WEBP'),
				...body
			]);
		};
		const u24 = (n: number) => [n & 255, (n >> 8) & 255, n >> 16];
		/** Stills as a canvas makes them: the bytes of "VP8 " say which color it was. */
		const stills: StillWebpEncoder = async (pixels, width, height) =>
			riff(
				chunk('VP8X', [0, 0, 0, 0, ...u24(width - 1), ...u24(height - 1)]),
				chunk('VP8 ', [pixels[0], pixels[1], pixels[2]])
			);

		it('counts the frames of a WebP the app makes, and how long they play', async () => {
			const encoder = new WebpEncoder({ width: 300, height: 200, fps: 12, encodeStill: stills });
			for (const color of [RED, GREEN, GREEN, BLUE]) await encoder.addFrame(solid(300, 200, color));
			const file = concat(encoder.finish());
			// 83, 84 + 83 and 83 ms: the rounding is carried.
			expect(readImage(file)).toEqual({
				format: 'webp',
				animated: true,
				width: 300,
				height: 200,
				frames: 3,
				duration: 0.333
			});
			expect(readAnimatedWebp(file).frames.map((f) => f.duration)).toEqual([83, 167, 83]);
		});

		it('reads the size of a still: lossy, lossless, or extended without an animation', () => {
			// A key frame's tag, start code, then 14-bit width and height.
			const vp8 = [0x9d, 0x01, 0, 0x9d, 0x01, 0x2a, 640 & 255, 640 >> 8, 360 & 255, 360 >> 8];
			expect(readImage(riff(chunk('VP8 ', vp8)))).toEqual({
				format: 'webp',
				animated: false,
				width: 640,
				height: 360,
				frames: 1,
				duration: null
			});
			// The signature byte, then 14 bits of width - 1 and 14 of height - 1.
			const bits = (100 - 1) | ((50 - 1) << 14);
			expect(readImage(riff(chunk('VP8L', [0x2f, ...u32le(bits)])))).toMatchObject({
				width: 100,
				height: 50,
				frames: 1
			});
			const vp8x = chunk('VP8X', [0x10, 0, 0, 0, ...u24(999), ...u24(1)]);
			expect(readImage(riff(vp8x, chunk('VP8 ', vp8)))).toMatchObject({
				animated: false,
				width: 1000,
				height: 2
			});
		});

		it('says nothing of an animation whose frames are not there', () => {
			const vp8x = chunk('VP8X', [0x02, 0, 0, 0, ...u24(9), ...u24(9)]);
			expect(readImage(riff(vp8x, chunk('ANIM', [0, 0, 0, 0, 0, 0])))).toEqual({
				format: 'webp',
				animated: true,
				width: 10,
				height: 10,
				frames: null,
				duration: null
			});
		});
	});

	describe('AVIF', () => {
		/** An AV1 encoder of Chromium-shaped temporal units (see avif.test.ts). */
		function fakeAv1(): Av1Encoder {
			const output: Av1Output = { chunks: [] };
			let n = 0;
			return {
				async encode(_frame, timestamp, keyFrame) {
					const index = n++;
					const data = Uint8Array.from([
						0x12,
						0,
						...(keyFrame ? sequenceHeaderObu({ fullRange: false }) : []),
						(6 << 3) | 0b10,
						2,
						0xf0,
						index
					]);
					output.chunks.push({ data, key: keyFrame, timestamp });
				},
				async finish() {
					return output;
				}
			};
		}

		const box = (type: string, ...parts: number[][]) => {
			const body = parts.flat();
			return [...u32be(8 + body.length), ...bytes(type), ...body];
		};
		const fullBox = (type: string, version: number, flags: number, ...parts: number[][]) =>
			box(type, [version, 0, 0, flags], ...parts);
		const u16 = (n: number) => [n >> 8, n & 255];

		it('counts the frames of an AVIF the app makes, and how long they play', async () => {
			const encoder = new AvifEncoder({ width: 64, height: 36, fps: 10, encoder: fakeAv1() });
			for (let i = 0; i < 5; i++) await encoder.addFrame(new Uint8ClampedArray(64 * 36 * 4));
			const file = concat(await encoder.finish());
			expect(readImage(file)).toEqual({
				format: 'avif',
				animated: true,
				width: 64,
				height: 36,
				frames: 5,
				duration: 0.5
			});
			expect(readAvifStrictly(file).track.durations).toEqual([1, 1, 1, 1, 1]);
		});

		/** A still: ftyp, then a meta whose primary item (2) has `properties`, in order. */
		function still(properties: number[][], brand = 'avif') {
			const ipco = box('ipco', ...properties, box('ispe', [0, 0, 0, 0, ...u32be(7), ...u32be(7)]));
			// Item 1 has the last property (a 7 × 7 ispe); the primary item has the others.
			const associations = properties.map((_, i) => 0x80 | (i + 1));
			const ipma = fullBox(
				'ipma',
				0,
				0,
				u32be(2),
				[...u16(1), 1, properties.length + 1],
				[...u16(2), associations.length, ...associations]
			);
			return Uint8Array.from([
				...box('ftyp', bytes(brand), u32be(0), bytes('mif1'), bytes('miaf')),
				...fullBox('meta', 0, 0, fullBox('pitm', 0, 0, u16(2)), box('iprp', ipco, ipma))
			]);
		}
		const ispe = (width: number, height: number) =>
			fullBox('ispe', 0, 0, u32be(width), u32be(height));

		it("reads a still's size from its primary item, as cropped and turned", () => {
			expect(readImage(still([ispe(400, 300)]))).toEqual({
				format: 'avif',
				animated: false,
				width: 400,
				height: 300,
				frames: 1,
				duration: null
			});
			// A quarter turn swaps them; a half turn does not.
			expect(readImage(still([ispe(400, 300), box('irot', [1])]))).toMatchObject({
				width: 300,
				height: 400
			});
			expect(readImage(still([ispe(400, 300), box('irot', [2])]))).toMatchObject({
				width: 400,
				height: 300
			});
			// A clean aperture of 398/2 × 150, then turned.
			const clap = box(
				'clap',
				u32be(398),
				u32be(2),
				u32be(150),
				u32be(1),
				u32be(0),
				u32be(1),
				u32be(0),
				u32be(1)
			);
			expect(readImage(still([ispe(400, 300), clap, box('irot', [3])]))).toMatchObject({
				width: 150,
				height: 199
			});
		});

		it('reads only files branded AVIF', () => {
			expect(readImage(still([ispe(4, 4)], 'heic'))).toBeNull();
			expect(readImage(still([ispe(4, 4)], 'avis'))).toMatchObject({ format: 'avif' });
		});

		it('refuses one whose size it cannot find', () => {
			expect(readImage(still([box('irot', [1])]))).toBeNull();
		});
	});

	describe('JPEG XL', () => {
		function jxl(frames: Uint8ClampedArray[], width: number, height: number, fps: number) {
			const encoder = new JxlEncoder({ width, height, fps });
			for (const frame of frames) encoder.addFrame(frame);
			return concat(encoder.finish());
		}

		it('counts the frames of a JPEG XL the app makes, and how long they play', () => {
			const [red, green, blue] = [RED, GREEN, BLUE].map((c) => solid(20, 10, c));
			const file = jxl([red, green, green, green, blue], 20, 10, 12);
			expect(readImage(file)).toEqual({
				format: 'jxl',
				animated: true,
				width: 20,
				height: 10,
				frames: 3,
				duration: 5 / 12
			});
			// As jxl-oxide reads it: three frames, of 1, 3 and 1 ticks.
			const decoded = decodeJxl(file);
			expect(decoded.frames.map((f) => f.ticksTimesTps / 12)).toEqual([1, 3, 1]);
		});

		it('walks frames of many groups, and of many LF groups', () => {
			const stripes = (width: number, height: number, shift: number) => {
				const out = solid(width, height, RED);
				for (let i = shift; i < width * height; i += 7) out.set([0, (i * 3) & 255, 90], i * 4);
				return out;
			};
			// 2 × 2 groups of 256 × 256.
			const square = jxl(
				[0, 1, 2].map((s) => stripes(300, 260, s)),
				300,
				260,
				10
			);
			expect(readImage(square)).toMatchObject({
				width: 300,
				height: 260,
				frames: 3,
				duration: 0.3
			});
			// 9 groups across, in 2 LF groups of 2048.
			const wide = jxl(
				[0, 1].map((s) => stripes(2100, 9, s)),
				2100,
				9,
				5
			);
			expect(readImage(wide)).toMatchObject({ width: 2100, height: 9, frames: 2, duration: 0.4 });
		});

		it('reads one in a container, whole or in parts', () => {
			const codestream = jxl([solid(8, 8, RED), solid(8, 8, BLUE)], 8, 8, 4);
			const box = (type: string, payload: ArrayLike<number>) =>
				concat([u32be(8 + payload.length), bytes(type), payload]);
			const signature = box('JXL ', [0x0d, 0x0a, 0x87, 0x0a]);
			const ftyp = box('ftyp', [...bytes('jxl '), 0, 0, 0, 0, ...bytes('jxl ')]);
			const expected = { format: 'jxl', width: 8, height: 8, frames: 2, duration: 0.5 };
			expect(readImage(concat([signature, ftyp, box('jxlc', codestream)]))).toMatchObject(expected);
			const half = codestream.length >> 1;
			const parts = concat([
				signature,
				ftyp,
				box('jxlp', concat([u32be(0), codestream.subarray(0, half)])),
				box('Exif', [0, 0, 0, 0]),
				box('jxlp', concat([u32be(0x80000001), codestream.subarray(half)]))
			]);
			expect(readImage(parts)).toMatchObject(expected);
		});

		it('counts nothing it cannot read to the very end', () => {
			const file = jxl([solid(8, 8, RED), solid(8, 8, BLUE)], 8, 8, 4);
			const unknown = { animated: true, width: 8, height: 8, frames: null, duration: null };
			expect(readImage(file.subarray(0, -1))).toMatchObject(unknown);
			expect(readImage(concat([file, [0]]))).toMatchObject(unknown);
		});

		/** Writes a codestream's header fields, least significant bit first. */
		class Bits {
			readonly bits: number[] = [];
			put(n: number, value: number) {
				for (let i = 0; i < n; i++) this.bits.push(Math.floor(value / 2 ** i) % 2);
				return this;
			}
			bool(value: boolean) {
				return this.put(1, value ? 1 : 0);
			}
			/** A U32: the distribution's selector, then its bits. */
			u32(selector: number, n = 0, value = 0) {
				return this.put(2, selector).put(n, value);
			}
			pad() {
				while (this.bits.length % 8) this.bits.push(0);
				return this;
			}
			bytes(): number[] {
				this.pad();
				const out: number[] = [];
				for (let i = 0; i < this.bits.length; i += 8) {
					out.push(this.bits.slice(i, i + 8).reduce((byte, bit, j) => byte | (bit << j), 0));
				}
				return out;
			}
		}

		/**
		 * An image header: 40 × 24 (as stored), then the metadata `extra` writes
		 * after "not all default, extra fields": orientation onwards.
		 */
		function header(extra: (w: Bits) => void): Bits {
			const w = new Bits().put(8, 0xff).put(8, 0x0a);
			w.bool(false).u32(0, 9, 23).put(3, 0).u32(0, 9, 39);
			w.bool(false).bool(true);
			extra(w);
			return w;
		}

		/** Bit depth 8, 16-bit buffers, `ec` default alpha channels, `xyb`, sRGB, default tone mapping, no extensions, default transform. */
		function rest(w: Bits, { ec = 0, xyb = false, colour = (b: Bits) => b.bool(true) } = {}) {
			w.bool(false).u32(0).bool(true);
			if (ec === 0) w.u32(0);
			else w.u32(1);
			for (let i = 0; i < ec; i++) w.bool(true);
			w.bool(xyb);
			colour(w);
			w.bool(true).u32(0).bool(true);
		}

		it('reads a still: its size as oriented, one frame, no walk', () => {
			// Orientation 6 (a quarter turn), no intrinsic size, preview or animation.
			const still = header((w) => {
				w.put(3, 5).bool(false).bool(false).bool(false);
				rest(w);
			});
			expect(readImage(Uint8Array.from(still.bytes()))).toEqual({
				format: 'jxl',
				animated: false,
				width: 24,
				height: 40,
				frames: 1,
				duration: null
			});
			// All default, but for the size: 8 × 8 · 2 by a ratio of 2:1.
			const small = new Bits().put(8, 0xff).put(8, 0x0a).bool(true).put(5, 1).put(3, 7);
			small.bool(true).bool(true);
			expect(readImage(Uint8Array.from(small.bytes()))).toMatchObject({ width: 32, height: 16 });
		});

		/** An animation at 10 ticks a second. */
		const animation = (w: Bits) =>
			w.put(3, 0).bool(false).bool(false).bool(true).u32(2, 10, 9).u32(0).u32(0).bool(false);

		it('walks frames of what the app does not write: crops, blending, extra channels, reference frames', () => {
			const w = header((w) => {
				animation(w);
				// One alpha channel, XYB: frame headers then hold more fields.
				rest(w, { ec: 1, xyb: true });
			});
			w.pad();
			const section = (w: Bits, size: number) => {
				// Not permuted; one TOC entry; then that many bytes.
				w.bool(false).pad().u32(0, 10, size).pad();
				for (let i = 0; i < size; i++) w.put(8, 0xa5);
			};
			// 1: a regular VarDCT frame, cropped to 8 × 8 at (4, 2), blended over what is there by
			// its alpha channel, shown for 5 ticks, then kept as a reference.
			w.bool(false).put(2, 0).bool(false).put(2, 0);
			w.u32(0); // upsampling 1
			w.u32(0); // the extra channel's upsampling
			w.put(3, 3).put(3, 2); // x and b quantization matrix scales
			w.u32(0); // one pass
			w.bool(true).u32(0, 8, 8).u32(0, 8, 4).u32(0, 8, 8).u32(0, 8, 8); // crop: (4, 2) and 8 × 8
			w.u32(2).u32(0).bool(false).put(2, 1); // blend, alpha channel 0, no clamp, source 1
			w.u32(2).u32(0).bool(false).put(2, 1); // the extra channel: likewise
			w.u32(2, 8, 5); // 5 ticks
			w.bool(false).put(2, 1); // not last, saved as reference 1
			w.u32(1, 4, 3).put(24, 0x6f6f66); // named "foo"
			w.bool(false).bool(true).bool(false).put(2, 1); // Gabor on, edge-preserving filter: 1 pass …
			w.bool(false).bool(true).put(48, 0).put(32, 0); // … custom channel scales …
			w.bool(true).put(64, 0); // … and sigma: four of them in a VarDCT frame
			w.u32(0); // no filter extensions
			w.u32(1, 4, 0); // a frame extension, number 0 …
			w.u32(1, 4, 2).put(3, 5); // … of 3 bits
			section(w, 3);
			// 2: reference only, modular, the whole canvas: never shown.
			w.bool(false).put(2, 2).bool(true).put(2, 0).u32(0).u32(0).put(2, 1);
			w.bool(false); // no crop
			w.put(2, 0); // not last: saved as reference 0 …
			w.bool(true); // … before the colour transform
			w.u32(0).bool(true).u32(0);
			section(w, 2);
			// 3: all default: regular, last, no time of its own.
			w.bool(true);
			section(w, 4);
			expect(readImage(Uint8Array.from(w.bytes()))).toEqual({
				format: 'jxl',
				animated: true,
				width: 40,
				height: 24,
				frames: 2,
				duration: 0.5
			});
		});

		it('counts no frames past an ICC profile or a preview: what comes first is not walked', () => {
			const icc = header((w) => {
				animation(w);
				rest(w, { colour: (b) => b.bool(false).bool(true).u32(0) });
			});
			const unknown = { animated: true, width: 40, height: 24, frames: null, duration: null };
			expect(readImage(Uint8Array.from(icc.bytes()))).toMatchObject(unknown);
			const preview = header((w) => {
				w.put(3, 0).bool(false);
				w.bool(true).bool(true).u32(0).put(3, 1); // a preview, 128 × 128
				w.bool(true).u32(0).u32(0).u32(0).bool(false); // an animation at 100 ticks a second
				rest(w);
			});
			expect(readImage(Uint8Array.from(preview.bytes()))).toMatchObject(unknown);
		});
	});
});
