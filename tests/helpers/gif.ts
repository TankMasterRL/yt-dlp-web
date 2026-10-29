/**
 * A strict GIF89a decoder for tests, written from the specification and
 * independent of the app's encoder: it composites every frame the way a
 * browser shows it, and throws on anything malformed (a code past the
 * table, pixels missing or left over, a missing terminator) instead of
 * guessing, so an encoder bug fails a test rather than rendering oddly.
 */

export interface DecodedFrame {
	/** Centiseconds. */
	delay: number;
	disposal: number;
	transparentIndex: number | null;
	rect: { x: number; y: number; width: number; height: number };
	/** The frame's own palette indices, before compositing. */
	indices: Uint8Array;
	/** What is on screen once this frame is drawn: the whole canvas, RGBA. */
	canvas: Uint8ClampedArray;
}

export interface DecodedGif {
	width: number;
	height: number;
	/** Entries in the global color table, as RGB triples. */
	globalPalette: Uint8Array | null;
	/** NETSCAPE2.0 loop count (0 = forever), or null when the GIF plays once. */
	loop: number | null;
	frames: DecodedFrame[];
	/** The LZW minimum code size of each frame. */
	minCodeSizes: number[];
}

class Reader {
	offset = 0;
	constructor(readonly bytes: Uint8Array) {}

	byte(): number {
		if (this.offset >= this.bytes.length) throw new Error('GIF ends early');
		return this.bytes[this.offset++];
	}

	u16(): number {
		return this.byte() | (this.byte() << 8);
	}

	take(n: number): Uint8Array {
		if (this.offset + n > this.bytes.length) throw new Error('GIF ends early');
		const out = this.bytes.subarray(this.offset, this.offset + n);
		this.offset += n;
		return out;
	}

	/** A chain of data sub-blocks, up to and including its zero-length terminator. */
	subBlocks(): Uint8Array {
		const parts: Uint8Array[] = [];
		for (let size = this.byte(); size; size = this.byte()) parts.push(this.take(size));
		const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let at = 0;
		for (const part of parts) {
			out.set(part, at);
			at += part.length;
		}
		return out;
	}
}

export function lzwDecode(data: Uint8Array, minCodeSize: number, pixels: number): Uint8Array {
	if (minCodeSize < 2 || minCodeSize > 8)
		throw new Error(`bad LZW minimum code size ${minCodeSize}`);
	const clear = 1 << minCodeSize;
	const end = clear + 1;
	const prefix = new Int32Array(4096);
	const suffix = new Uint8Array(4096);
	const first = new Uint8Array(4096);
	for (let i = 0; i < clear; i++) {
		prefix[i] = -1;
		suffix[i] = i;
		first[i] = i;
	}
	const out = new Uint8Array(pixels);
	const stack = new Uint8Array(4096);
	let written = 0;
	let codeSize = minCodeSize + 1;
	let next = end + 1;
	let previous = -1;
	let bits = 0;
	let bitCount = 0;
	let at = 0;
	let ended = false;

	const emit = (code: number) => {
		let depth = 0;
		for (let c = code; c !== -1; c = prefix[c]) stack[depth++] = suffix[c];
		if (written + depth > pixels) throw new Error('LZW data holds more pixels than the frame');
		while (depth) out[written++] = stack[--depth];
	};

	for (;;) {
		while (bitCount < codeSize) {
			if (at >= data.length) throw new Error('LZW data ends without an end-of-information code');
			bits |= data[at++] << bitCount;
			bitCount += 8;
		}
		const code = bits & ((1 << codeSize) - 1);
		bits >>>= codeSize;
		bitCount -= codeSize;

		if (code === clear) {
			codeSize = minCodeSize + 1;
			next = end + 1;
			previous = -1;
			continue;
		}
		if (code === end) {
			ended = true;
			break;
		}
		if (previous === -1) {
			if (code >= clear) throw new Error(`LZW code ${code} before any table entry`);
			emit(code);
			previous = code;
			continue;
		}
		if (code > next || (code === next && next >= 4096)) {
			throw new Error(`LZW code ${code} is past the table (next ${next})`);
		}
		if (next < 4096) {
			prefix[next] = previous;
			suffix[next] = code === next ? first[previous] : first[code];
			first[next] = first[previous];
			next++;
			if (next === 1 << codeSize && codeSize < 12) codeSize++;
		}
		emit(code);
		previous = code;
	}
	if (!ended) throw new Error('no end-of-information code');
	if (written !== pixels) throw new Error(`LZW data holds ${written} of ${pixels} pixels`);
	// Whatever follows the end code must be padding within the last byte.
	if (at !== data.length) throw new Error(`${data.length - at} bytes after the end code`);
	return out;
}

export function decodeGif(bytes: Uint8Array): DecodedGif {
	const r = new Reader(bytes);
	const signature = new TextDecoder().decode(r.take(6));
	if (signature !== 'GIF89a') throw new Error(`not a GIF89a: ${signature}`);
	const width = r.u16();
	const height = r.u16();
	const packed = r.byte();
	r.byte(); // background color index
	r.byte(); // pixel aspect ratio
	const globalPalette = packed & 0x80 ? r.take(3 << ((packed & 7) + 1)) : null;

	const canvas = new Uint8ClampedArray(width * height * 4);
	const frames: DecodedFrame[] = [];
	const minCodeSizes: number[] = [];
	let loop: number | null = null;
	let control = { delay: 0, disposal: 0, transparentIndex: null as number | null };
	let restore: (() => void) | null = null;

	for (;;) {
		const introducer = r.byte();
		if (introducer === 0x3b) break;
		if (introducer === 0x21) {
			const label = r.byte();
			if (label === 0xf9) {
				if (r.byte() !== 4) throw new Error('graphic control extension of the wrong size');
				const flags = r.byte();
				const delay = r.u16();
				const transparent = r.byte();
				if (r.byte() !== 0) throw new Error('graphic control extension not terminated');
				control = {
					delay,
					disposal: (flags >> 2) & 7,
					transparentIndex: flags & 1 ? transparent : null
				};
			} else if (label === 0xff) {
				const size = r.byte();
				const id = new TextDecoder().decode(r.take(size));
				const data = r.subBlocks();
				if (id === 'NETSCAPE2.0' && data[0] === 1) loop = data[1] | (data[2] << 8);
			} else {
				r.subBlocks();
			}
			continue;
		}
		if (introducer !== 0x2c) throw new Error(`unexpected block 0x${introducer.toString(16)}`);

		const rect = { x: r.u16(), y: r.u16(), width: r.u16(), height: r.u16() };
		if (rect.x + rect.width > width || rect.y + rect.height > height) {
			throw new Error('frame outside the canvas');
		}
		const flags = r.byte();
		if (flags & 0x40) throw new Error('interlaced frames are not expected');
		const palette = flags & 0x80 ? r.take(3 << ((flags & 7) + 1)) : globalPalette;
		if (!palette) throw new Error('frame without a color table');
		const minCodeSize = r.byte();
		minCodeSizes.push(minCodeSize);
		const indices = lzwDecode(r.subBlocks(), minCodeSize, rect.width * rect.height);

		// The previous frame's disposal applies before this one is drawn.
		restore?.();
		const before = control.disposal === 3 ? canvas.slice() : null;
		for (let row = 0; row < rect.height; row++) {
			for (let col = 0; col < rect.width; col++) {
				const index = indices[row * rect.width + col];
				if (index === control.transparentIndex) continue;
				if (index * 3 >= palette.length) throw new Error(`index ${index} past the color table`);
				const at = ((rect.y + row) * width + rect.x + col) * 4;
				canvas[at] = palette[index * 3];
				canvas[at + 1] = palette[index * 3 + 1];
				canvas[at + 2] = palette[index * 3 + 2];
				canvas[at + 3] = 255;
			}
		}
		frames.push({ ...control, rect, indices, canvas: canvas.slice() });
		const { disposal } = control;
		restore =
			disposal === 2
				? () => {
						for (let row = 0; row < rect.height; row++) {
							const at = ((rect.y + row) * width + rect.x) * 4;
							canvas.fill(0, at, at + rect.width * 4);
						}
					}
				: disposal === 3
					? () => canvas.set(before!)
					: null;
		control = { delay: 0, disposal: 0, transparentIndex: null };
	}
	if (r.offset !== bytes.length) throw new Error('bytes after the trailer');
	return { width, height, globalPalette, loop, frames, minCodeSizes };
}
