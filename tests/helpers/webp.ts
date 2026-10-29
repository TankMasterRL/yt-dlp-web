/**
 * A strict reader of animated WebP containers for tests, written from the
 * WebP container specification and independent of the app's muxer: it checks
 * the RIFF sizes and padding and the VP8X/ANIM/ANMF fields, and can rewrap
 * each frame as a still WebP for a decoder to read.
 */

export interface WebpChunk {
	type: string;
	data: Uint8Array;
}

export interface WebpFrame {
	x: number;
	y: number;
	width: number;
	height: number;
	/** Milliseconds. */
	duration: number;
	/** ANMF's blending bit: true means do not blend. */
	noBlend: boolean;
	/** ANMF's disposal bit: true means dispose to the background colour. */
	dispose: boolean;
	/** The frame's own chunks: ALPH and VP8, or VP8L. */
	chunks: WebpChunk[];
}

export interface AnimatedWebp {
	width: number;
	height: number;
	flags: { alpha: boolean; animation: boolean };
	loops: number;
	background: number;
	frames: WebpFrame[];
}

const u24 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32 = (b: Uint8Array, at: number) => (u24(b, at) | (b[at + 3] << 24)) >>> 0;
const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(...b.subarray(at, at + 4));

/** The chunks of `bytes`, which must be exactly a sequence of padded chunks. */
export function readChunks(bytes: Uint8Array): WebpChunk[] {
	const chunks: WebpChunk[] = [];
	let at = 0;
	while (at < bytes.length) {
		if (at + 8 > bytes.length) throw new Error('a chunk header ends early');
		const type = fourcc(bytes, at);
		const size = u32(bytes, at + 4);
		const data = bytes.subarray(at + 8, at + 8 + size);
		if (data.length !== size) throw new Error(`${type} ends early`);
		if (size % 2 && bytes[at + 8 + size] !== 0)
			throw new Error(`${type} is not padded with a zero`);
		chunks.push({ type, data });
		at += 8 + size + (size % 2);
	}
	if (at !== bytes.length) throw new Error('bytes after the last chunk');
	return chunks;
}

export function readWebp(bytes: Uint8Array): WebpChunk[] {
	if (fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WEBP') throw new Error('not a WebP');
	if (u32(bytes, 4) !== bytes.length - 8)
		throw new Error(`RIFF size ${u32(bytes, 4)}, file ${bytes.length}`);
	return readChunks(bytes.subarray(12));
}

export function readAnimatedWebp(bytes: Uint8Array): AnimatedWebp {
	const chunks = readWebp(bytes);
	const [vp8x, anim, ...rest] = chunks;
	if (vp8x?.type !== 'VP8X' || vp8x.data.length !== 10) throw new Error('no VP8X first');
	if (anim?.type !== 'ANIM' || anim.data.length !== 6) throw new Error('no ANIM second');
	const flags = vp8x.data[0];
	if (flags & 0xc1) throw new Error('reserved VP8X bits set');
	const width = u24(vp8x.data, 4) + 1;
	const height = u24(vp8x.data, 7) + 1;
	const frames = rest.map((chunk): WebpFrame => {
		if (chunk.type !== 'ANMF') throw new Error(`unexpected ${chunk.type}`);
		const d = chunk.data;
		const frame = {
			x: u24(d, 0) * 2,
			y: u24(d, 3) * 2,
			width: u24(d, 6) + 1,
			height: u24(d, 9) + 1,
			duration: u24(d, 12),
			noBlend: Boolean(d[15] & 2),
			dispose: Boolean(d[15] & 1),
			chunks: readChunks(d.subarray(16))
		};
		if (frame.x + frame.width > width || frame.y + frame.height > height) {
			throw new Error('frame outside the canvas');
		}
		const types = frame.chunks.map((c) => c.type).join(',');
		if (!['VP8 ', 'ALPH,VP8 ', 'VP8L'].includes(types)) throw new Error(`frame chunks ${types}`);
		return frame;
	});
	return {
		width,
		height,
		flags: { alpha: Boolean(flags & 0x10), animation: Boolean(flags & 0x02) },
		loops: anim.data[4] | (anim.data[5] << 8),
		background: u32(anim.data, 0),
		frames
	};
}

function chunkBytes({ type, data }: WebpChunk): Uint8Array {
	const out = new Uint8Array(8 + data.length + (data.length % 2));
	out.set([...type].map((c) => c.charCodeAt(0)));
	new DataView(out.buffer).setUint32(4, data.length, true);
	out.set(data, 8);
	return out;
}

/** One frame as a still WebP file, for a still-image decoder. */
export function stillWebp(frame: WebpFrame): Uint8Array {
	const body: Uint8Array[] = [];
	if (frame.chunks[0].type === 'ALPH') {
		const vp8x = new Uint8Array(10);
		vp8x[0] = 0x10;
		vp8x.set([(frame.width - 1) & 255, ((frame.width - 1) >> 8) & 255, (frame.width - 1) >> 16], 4);
		vp8x.set(
			[(frame.height - 1) & 255, ((frame.height - 1) >> 8) & 255, (frame.height - 1) >> 16],
			7
		);
		body.push(chunkBytes({ type: 'VP8X', data: vp8x }));
	}
	body.push(...frame.chunks.map(chunkBytes));
	const size = 4 + body.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(8 + size);
	out.set([...'RIFF'].map((c) => c.charCodeAt(0)));
	new DataView(out.buffer).setUint32(4, size, true);
	out.set(
		[...'WEBP'].map((c) => c.charCodeAt(0)),
		8
	);
	body.reduce((at, c) => (out.set(c, at), at + c.length), 12);
	return out;
}
