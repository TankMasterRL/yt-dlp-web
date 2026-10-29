/**
 * Just enough AV1 bitstream (AV1 specification, sections 5.3 and 5.5) to
 * carry WebCodecs' output in an AVIF file: splitting temporal units into
 * OBUs, dropping the ones ISOBMFF samples must not hold, and reading the
 * sequence header for the av1C configuration box (AV1-ISOBMFF, section 2.3).
 */

export interface Obu {
	type: number;
	/** Where the whole OBU, header included, starts and ends. */
	start: number;
	end: number;
	/** Payload size. */
	size: number;
	/** Where the payload starts. */
	payload: number;
}

export const OBU_SEQUENCE_HEADER = 1;
const OBU_TEMPORAL_DELIMITER = 2;
const OBU_TILE_LIST = 8;
const OBU_PADDING = 15;

/** The OBUs of `data`, in order. One without a size field runs to the end. */
export function readObus(data: Uint8Array): Obu[] {
	const obus: Obu[] = [];
	let at = 0;
	while (at < data.length) {
		const start = at;
		const header = data[at++];
		const type = (header >> 3) & 0xf;
		if (header & 0b100) at++; // extension header
		let size = data.length - at;
		if (header & 0b10) {
			size = 0;
			for (let shift = 0; ; shift += 7) {
				const byte = data[at++];
				size += (byte & 0x7f) * 2 ** shift;
				if (!(byte & 0x80)) break;
			}
		}
		obus.push({ type, start, end: at + size, size, payload: at });
		at += size;
	}
	return obus;
}

/** A temporal unit as an ISOBMFF sample: no temporal delimiters, padding or tile lists. */
export function stripForIsobmff(unit: Uint8Array): Uint8Array {
	const keep = readObus(unit).filter(
		(o) => o.type !== OBU_TEMPORAL_DELIMITER && o.type !== OBU_PADDING && o.type !== OBU_TILE_LIST
	);
	const out = new Uint8Array(keep.reduce((n, o) => n + o.end - o.start, 0));
	keep.reduce((at, o) => (out.set(unit.subarray(o.start, o.end), at), at + o.end - o.start), 0);
	return out;
}

export interface SequenceHeader {
	profile: number;
	/** seq_level_idx of the first operating point. */
	level: number;
	tier: number;
	highBitdepth: boolean;
	twelveBit: boolean;
	monochrome: boolean;
	subsamplingX: number;
	subsamplingY: number;
	chromaSamplePosition: number;
	/** CICP code points, when the stream states them. */
	colorDescription: { primaries: number; transfer: number; matrix: number } | null;
	fullRange: boolean;
}

class BitReader {
	#at = 0;
	constructor(readonly bytes: Uint8Array) {}

	/** `n` bits, most significant first. */
	f(n: number): number {
		let v = 0;
		for (let i = 0; i < n; i++) {
			const byte = this.bytes[this.#at >> 3];
			if (byte === undefined) throw new Error('the AV1 sequence header ends early');
			v = v * 2 + ((byte >> (7 - (this.#at & 7))) & 1);
			this.#at++;
		}
		return v;
	}

	flag(): boolean {
		return this.f(1) === 1;
	}

	uvlc(): number {
		let zeros = 0;
		while (!this.flag()) zeros++;
		return zeros >= 32 ? 2 ** 32 - 1 : this.f(zeros) + 2 ** zeros - 1;
	}
}

const CP_BT_709 = 1;
const TC_SRGB = 13;
const MC_IDENTITY = 0;

/** Reads a sequence header OBU (header and size included) up to its colour config. */
export function parseSequenceHeader(obu: Uint8Array): SequenceHeader {
	const [first] = readObus(obu);
	if (first?.type !== OBU_SEQUENCE_HEADER) throw new Error('not a sequence header OBU');
	const r = new BitReader(obu.subarray(first.payload, first.end));
	const profile = r.f(3);
	r.f(1); // still_picture
	const reduced = r.flag();
	let level: number;
	let tier = 0;
	if (reduced) {
		level = r.f(5);
	} else {
		let decoderModel = false;
		let bufferDelayLength = 0;
		if (r.flag()) {
			// timing_info
			r.f(32);
			r.f(32);
			if (r.flag()) r.uvlc();
			decoderModel = r.flag();
			if (decoderModel) {
				bufferDelayLength = r.f(5) + 1;
				r.f(32);
				r.f(5);
				r.f(5);
			}
		}
		const initialDisplayDelay = r.flag();
		const operatingPoints = r.f(5) + 1;
		level = 0;
		for (let i = 0; i < operatingPoints; i++) {
			r.f(12); // operating_point_idc
			const idx = r.f(5);
			const t = idx > 7 ? r.f(1) : 0;
			if (i === 0) [level, tier] = [idx, t];
			if (decoderModel && r.flag()) {
				r.f(bufferDelayLength);
				r.f(bufferDelayLength);
				r.f(1);
			}
			if (initialDisplayDelay && r.flag()) r.f(4);
		}
	}
	const widthBits = r.f(4) + 1;
	const heightBits = r.f(4) + 1;
	r.f(widthBits);
	r.f(heightBits);
	if (!reduced && r.flag()) {
		r.f(4);
		r.f(3);
	}
	r.f(3); // 128×128 superblocks, filter intra, intra edge filter
	if (!reduced) {
		r.f(4); // interintra compound, masked compound, warped motion, dual filter
		const orderHint = r.flag();
		if (orderHint) r.f(2); // jnt_comp, ref_frame_mvs
		const forceScreenContentTools = r.flag() ? 2 : r.f(1);
		if (forceScreenContentTools > 0 && !r.flag()) r.f(1); // seq_force_integer_mv
		if (orderHint) r.f(3);
	}
	r.f(3); // superres, cdef, restoration

	// color_config
	const highBitdepth = r.flag();
	const twelveBit = profile === 2 && highBitdepth ? r.flag() : false;
	const monochrome = profile === 1 ? false : r.flag();
	const colorDescription = r.flag()
		? { primaries: r.f(8), transfer: r.f(8), matrix: r.f(8) }
		: null;
	let fullRange: boolean;
	let [subsamplingX, subsamplingY, chromaSamplePosition] = [1, 1, 0];
	if (monochrome) {
		fullRange = r.flag();
	} else if (
		colorDescription?.primaries === CP_BT_709 &&
		colorDescription.transfer === TC_SRGB &&
		colorDescription.matrix === MC_IDENTITY
	) {
		fullRange = true;
		[subsamplingX, subsamplingY] = [0, 0];
	} else {
		fullRange = r.flag();
		if (profile === 1) [subsamplingX, subsamplingY] = [0, 0];
		else if (profile === 2) {
			if (twelveBit) {
				subsamplingX = r.f(1);
				subsamplingY = subsamplingX ? r.f(1) : 0;
			} else [subsamplingX, subsamplingY] = [1, 0];
		}
		if (subsamplingX && subsamplingY) chromaSamplePosition = r.f(2);
	}
	return {
		profile,
		level,
		tier,
		highBitdepth,
		twelveBit,
		monochrome,
		subsamplingX,
		subsamplingY,
		chromaSamplePosition,
		colorDescription,
		fullRange
	};
}

/** The av1C box's payload: AV1CodecConfigurationRecord with the sequence header as its config OBU. */
export function av1Config(sequenceHeaderObu: Uint8Array): Uint8Array {
	const h = parseSequenceHeader(sequenceHeaderObu);
	const out = new Uint8Array(4 + sequenceHeaderObu.length);
	out[0] = 0x81; // marker, version 1
	out[1] = (h.profile << 5) | h.level;
	out[2] =
		(h.tier << 7) |
		(Number(h.highBitdepth) << 6) |
		(Number(h.twelveBit) << 5) |
		(Number(h.monochrome) << 4) |
		(h.subsamplingX << 3) |
		(h.subsamplingY << 2) |
		h.chromaSamplePosition;
	out[3] = 0; // no initial presentation delay
	out.set(sequenceHeaderObu, 4);
	return out;
}
