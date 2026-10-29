/**
 * A strict APNG decoder for tests, written from the PNG and APNG
 * specifications and independent of the app's encoder (zlib is Node's). It
 * checks every chunk's CRC and the fcTL/fdAT sequence numbers, and composites
 * the frames the way a browser shows them. Anything malformed throws.
 */
import { inflateSync } from 'node:zlib';

export interface ApngFrame {
	rect: { x: number; y: number; width: number; height: number };
	delay: { num: number; den: number };
	dispose: number;
	blend: number;
	/** The frame's own pixels, RGBA, before compositing. */
	pixels: Uint8ClampedArray;
	/** What is on screen once this frame is drawn: the whole canvas, RGBA. */
	canvas: Uint8ClampedArray;
}

export interface DecodedApng {
	width: number;
	height: number;
	colorType: number;
	/** acTL's num_plays: 0 loops forever. */
	plays: number;
	frames: ApngFrame[];
	/** How many IDAT and fdAT chunks carried image data. */
	dataChunks: number;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

const u32 = (b: Uint8Array, at: number) =>
	((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reverses PNG's per-row filters. */
export function unfilter(data: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
	const stride = width * bpp;
	if (data.length !== height * (stride + 1)) {
		throw new Error(`image data is ${data.length} bytes, expected ${height * (stride + 1)}`);
	}
	const out = new Uint8Array(height * stride);
	for (let y = 0; y < height; y++) {
		const type = data[y * (stride + 1)];
		const row = data.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		for (let x = 0; x < stride; x++) {
			const a = x >= bpp ? out[y * stride + x - bpp] : 0;
			const b = y > 0 ? out[(y - 1) * stride + x] : 0;
			const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
			const predicted = [0, a, b, (a + b) >> 1, paeth(a, b, c)][type];
			if (predicted === undefined) throw new Error(`unknown filter type ${type}`);
			out[y * stride + x] = (row[x] + predicted) & 0xff;
		}
	}
	return out;
}

export function decodeApng(bytes: Uint8Array): DecodedApng {
	SIGNATURE.forEach((b, i) => {
		if (bytes[i] !== b) throw new Error('not a PNG');
	});
	let at = 8;
	let header: { width: number; height: number; colorType: number } | null = null;
	let plays: number | null = null;
	let declaredFrames = 0;
	let sequence = 0;
	let dataChunks = 0;
	let ended = false;
	type Pending = Omit<ApngFrame, 'pixels' | 'canvas'> & { data: Uint8Array[] };
	const pending: Pending[] = [];
	while (at < bytes.length) {
		if (ended) throw new Error('bytes after IEND');
		const length = u32(bytes, at);
		const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
		const body = bytes.subarray(at + 8, at + 8 + length);
		if (body.length !== length) throw new Error(`${type} chunk ends early`);
		const crc = u32(bytes, at + 8 + length);
		if (crc !== crc32(bytes.subarray(at + 4, at + 8 + length)))
			throw new Error(`bad CRC in ${type}`);
		at += 12 + length;

		const expectSequence = () => {
			if (u32(body, 0) !== sequence) {
				throw new Error(`${type} sequence ${u32(body, 0)}, expected ${sequence}`);
			}
			sequence++;
		};
		switch (type) {
			case 'IHDR':
				if (body[8] !== 8) throw new Error('only 8-bit images are expected');
				if (body[10] || body[11] || body[12])
					throw new Error('unexpected compression, filter or interlace');
				header = { width: u32(body, 0), height: u32(body, 4), colorType: body[9] };
				break;
			case 'acTL':
				declaredFrames = u32(body, 0);
				plays = u32(body, 4);
				break;
			case 'fcTL': {
				expectSequence();
				const rect = {
					width: u32(body, 4),
					height: u32(body, 8),
					x: u32(body, 12),
					y: u32(body, 16)
				};
				if (!header || rect.x + rect.width > header.width || rect.y + rect.height > header.height) {
					throw new Error('frame outside the canvas');
				}
				if (
					!pending.length &&
					(rect.x || rect.y || rect.width !== header.width || rect.height !== header.height)
				) {
					throw new Error('the first frame must fill the canvas');
				}
				pending.push({
					rect,
					delay: { num: u16(body, 20), den: u16(body, 22) },
					dispose: body[24],
					blend: body[25],
					data: []
				});
				break;
			}
			case 'IDAT':
				if (!pending.length || pending.length > 1)
					throw new Error('IDAT must belong to the first frame');
				pending[0].data.push(body);
				dataChunks++;
				break;
			case 'fdAT':
				expectSequence();
				if (pending.length < 2) throw new Error('fdAT before a second frame');
				pending.at(-1)!.data.push(body.subarray(4));
				dataChunks++;
				break;
			case 'IEND':
				ended = true;
				break;
			default:
				if (type.charCodeAt(0) < 97) throw new Error(`unknown critical chunk ${type}`);
		}
	}
	if (!ended) throw new Error('no IEND');
	if (!header || plays === null) throw new Error('not an animated PNG');
	if (pending.length !== declaredFrames)
		throw new Error(`acTL says ${declaredFrames} frames, found ${pending.length}`);

	const { width, height, colorType } = header;
	const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
	if (!bpp) throw new Error(`unexpected color type ${colorType}`);
	const canvas = new Uint8ClampedArray(width * height * 4);
	const frames: ApngFrame[] = [];
	let restore: (() => void) | null = null;
	for (const frame of pending) {
		const { rect } = frame;
		const raw = unfilter(inflateSync(Buffer.concat(frame.data)), rect.width, rect.height, bpp);
		const pixels = new Uint8ClampedArray(rect.width * rect.height * 4);
		for (let i = 0; i < rect.width * rect.height; i++) {
			pixels.set(raw.subarray(i * bpp, i * bpp + 3), i * 4);
			pixels[i * 4 + 3] = bpp === 4 ? raw[i * bpp + 3] : 255;
		}
		restore?.();
		const before = frame.dispose === 2 ? canvas.slice() : null;
		for (let y = 0; y < rect.height; y++) {
			for (let x = 0; x < rect.width; x++) {
				const src = (y * rect.width + x) * 4;
				const dst = ((rect.y + y) * width + rect.x + x) * 4;
				const alpha = pixels[src + 3];
				if (frame.blend === 0 || alpha === 255) canvas.set(pixels.subarray(src, src + 4), dst);
				else if (alpha !== 0) throw new Error('partial alpha is not expected');
			}
		}
		frames.push({ ...frame, pixels, canvas: canvas.slice() });
		restore =
			frame.dispose === 1
				? () => {
						for (let y = 0; y < rect.height; y++) {
							const row = ((rect.y + y) * width + rect.x) * 4;
							canvas.fill(0, row, row + rect.width * 4);
						}
					}
				: frame.dispose === 2
					? () => canvas.set(before!)
					: null;
	}
	return { width, height, colorType, plays, frames, dataChunks };
}

/** A still PNG, 8 bits per channel: RGBA pixels whatever its color type. */
export function decodePng(bytes: Uint8Array): {
	width: number;
	height: number;
	pixels: Uint8ClampedArray;
} {
	SIGNATURE.forEach((b, i) => {
		if (bytes[i] !== b) throw new Error('not a PNG');
	});
	let at = 8;
	let header: { width: number; height: number; colorType: number; depth: number } | null = null;
	const data: Uint8Array[] = [];
	while (at < bytes.length) {
		const length = u32(bytes, at);
		const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
		const body = bytes.subarray(at + 8, at + 8 + length);
		if (u32(bytes, at + 8 + length) !== crc32(bytes.subarray(at + 4, at + 8 + length))) {
			throw new Error(`bad CRC in ${type}`);
		}
		at += 12 + length;
		if (type === 'IHDR') {
			header = { width: u32(body, 0), height: u32(body, 4), depth: body[8], colorType: body[9] };
		} else if (type === 'IDAT') data.push(body);
		else if (type === 'IEND') break;
	}
	if (!header) throw new Error('no IHDR');
	const { width, height, colorType, depth } = header;
	if (depth !== 8) throw new Error(`a ${depth}-bit PNG`);
	const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
	if (!channels) throw new Error(`unexpected color type ${colorType}`);
	const raw = unfilter(inflateSync(Buffer.concat(data)), width, height, channels);
	const pixels = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		const p = raw.subarray(i * channels, (i + 1) * channels);
		const [r, g, b, a] =
			channels === 1
				? [p[0], p[0], p[0], 255]
				: channels === 2
					? [p[0], p[0], p[0], p[1]]
					: channels === 3
						? [p[0], p[1], p[2], 255]
						: [p[0], p[1], p[2], p[3]];
		pixels.set([r, g, b, a], i * 4);
	}
	return { width, height, pixels };
}
