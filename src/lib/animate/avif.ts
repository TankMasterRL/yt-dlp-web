/**
 * Animated AVIF: the frames are compressed by the browser's own AV1 encoder
 * (WebCodecs), and this module writes the container — an AVIF image sequence
 * (AV1 Image File Format, the 'avis' brand), laid out as libavif lays it out:
 *
 *   ftyp  avis, compatible with still AVIF readers
 *   meta  the first frame as the primary image item, for readers of stills
 *   moov  one 'pict' track of every frame, in ticks of 1/fps, repeating forever
 *   mdat  the samples: each frame's temporal unit, minus its temporal delimiter
 *
 * The AV1 encoder is a seam: in the app it is WebCodecs' VideoEncoder
 * (`webCodecsAv1`), in tests a fake.
 */
import {
	OBU_SEQUENCE_HEADER,
	av1Config,
	parseSequenceHeader,
	readObus,
	stripForIsobmff
} from './av1';

export interface Av1Chunk {
	/** One temporal unit, as the encoder made it. */
	data: Uint8Array;
	key: boolean;
	/** Microseconds. */
	timestamp: number;
}

export interface Av1Output {
	chunks: Av1Chunk[];
	/** How the encoder turned RGB into YUV, when it says. */
	colorSpace: VideoColorSpaceInit | null;
	/** The encoder's own av1C record (WebCodecs' decoderConfig.description), when it gives one. */
	description?: Uint8Array | null;
}

/** An AV1 encoder fed one RGBA frame at a time. */
export interface Av1Encoder {
	encode(pixels: Uint8ClampedArray, timestamp: number, keyFrame: boolean): Promise<void>;
	/** Every chunk, in order, once every frame is in. */
	finish(): Promise<Av1Output>;
}

export interface AvifOptions {
	width: number;
	height: number;
	fps: number;
	encoder: Av1Encoder;
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Big-endian fields. */
function fields(...values: [bits: 8 | 16 | 32 | 64, value: number | bigint][]): Uint8Array {
	const out = new Uint8Array(values.reduce((n, [bits]) => n + bits / 8, 0));
	const view = new DataView(out.buffer);
	let at = 0;
	for (const [bits, value] of values) {
		if (bits === 8) view.setUint8(at, Number(value));
		else if (bits === 16) view.setUint16(at, Number(value));
		else if (bits === 32) view.setUint32(at, Number(value));
		else view.setBigUint64(at, BigInt(value));
		at += bits / 8;
	}
	return out;
}

type Part = Uint8Array | number[];

function box(type: string, ...parts: Part[]): Uint8Array<ArrayBuffer> {
	const size = 8 + parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(size);
	new DataView(out.buffer).setUint32(0, size);
	out.set(ascii(type), 4);
	parts.reduce((at, p) => (out.set(p, at), at + p.length), 8);
	return out;
}

const fullBox = (type: string, version: number, flags: number, ...parts: Part[]) =>
	box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...parts);

/** Duration of a sequence that repeats forever (all ones). */
const INDEFINITE = 2n ** 64n - 1n;
const UNITY_MATRIX = fields(
	[32, 0x00010000],
	[32, 0],
	[32, 0],
	[32, 0],
	[32, 0x00010000],
	[32, 0],
	[32, 0],
	[32, 0],
	[32, 0x40000000]
);
/** 'und', packed as ISO 639-2/T in three 5-bit letters. */
const LANGUAGE_UNDETERMINED = 0x55c4;

/** CICP code points (ITU-T H.273) for WebCodecs' colour space names. */
const PRIMARIES: Record<string, number> = {
	bt709: 1,
	bt470bg: 5,
	smpte170m: 6,
	bt2020: 9,
	smpte432: 12
};
const TRANSFER: Record<string, number> = {
	bt709: 1,
	smpte170m: 6,
	linear: 8,
	'iec61966-2-1': 13,
	pq: 16,
	hlg: 18
};
const MATRIX: Record<string, number> = {
	rgb: 0,
	bt709: 1,
	bt470bg: 5,
	smpte170m: 6,
	'bt2020-ncl': 9
};
const UNSPECIFIED = 2;

const handler = () =>
	fullBox('hdlr', 0, 0, fields([32, 0]), ascii('pict'), new Uint8Array(12), [0]);

export interface Sample {
	data: Uint8Array;
	sync: boolean;
	/** Ticks of the track's timescale. */
	duration: number;
}

/** The AVIF file's bytes for `samples` (their first must be a key frame with its sequence header). */
export function muxAvif(
	{ width, height, timescale }: { width: number; height: number; timescale: number },
	samples: Sample[],
	colorSpace: VideoColorSpaceInit | null,
	description: Uint8Array | null = null
): Uint8Array<ArrayBuffer>[] {
	const first = samples[0];
	// The sequence header: in the first key frame (Chromium), or else in the
	// config OBUs of the encoder's own av1C record.
	const sequenceHeader = (data: Uint8Array | undefined) => {
		const obu = data && readObus(data).find((o) => o.type === OBU_SEQUENCE_HEADER);
		return obu ? data.subarray(obu.start, obu.end) : null;
	};
	const headerObu = sequenceHeader(first?.data) ?? sequenceHeader(description?.subarray(4));
	if (!first?.sync || !headerObu) {
		throw new Error('An AVIF sequence must start with a key frame and its sequence header');
	}
	const sequence = parseSequenceHeader(headerObu);
	const av1C = box('av1C', av1Config(headerObu));
	// The bitstream's own colour description wins; then what the encoder said it did.
	const described = sequence.colorDescription;
	const code = (table: Record<string, number>, name: string | null | undefined): number =>
		name ? (table[name] ?? UNSPECIFIED) : UNSPECIFIED;
	const colr = box(
		'colr',
		ascii('nclx'),
		fields(
			[16, described?.primaries ?? code(PRIMARIES, colorSpace?.primaries)],
			[16, described?.transfer ?? code(TRANSFER, colorSpace?.transfer)],
			[16, described?.matrix ?? code(MATRIX, colorSpace?.matrix)],
			[8, sequence.fullRange ? 0x80 : 0]
		)
	);
	const total = samples.reduce((n, s) => n + s.duration, 0);
	const ftyp = box(
		'ftyp',
		ascii('avis'),
		fields([32, 0]),
		...['avif', 'avis', 'msf1', 'iso8', 'mif1', 'miaf', 'MA1B'].map(ascii)
	);

	/** meta and moov for samples starting at `mdatAt` in the file. */
	const layout = (mdatAt: number) => {
		const meta = fullBox(
			'meta',
			0,
			0,
			handler(),
			fullBox('pitm', 0, 0, fields([16, 1])),
			// One item, one extent: the first sample's bytes, 32-bit offset and length.
			fullBox(
				'iloc',
				0,
				0,
				[0x44, 0x00],
				fields([16, 1], [16, 1], [16, 0], [16, 1], [32, mdatAt], [32, first.data.length])
			),
			fullBox(
				'iinf',
				0,
				0,
				fields([16, 1]),
				fullBox('infe', 2, 0, fields([16, 1], [16, 0]), ascii('av01'), [0])
			),
			box(
				'iprp',
				box(
					'ipco',
					fullBox('ispe', 0, 0, fields([32, width], [32, height])),
					fullBox('pixi', 0, 0, [3, 8, 8, 8]),
					av1C,
					colr
				),
				// Item 1 has properties 1-4; av1C is essential to decoding it.
				fullBox('ipma', 0, 0, fields([32, 1], [16, 1], [8, 4]), [1, 2, 0x83, 4])
			)
		);
		const sync = samples.flatMap((s, i) => (s.sync ? [i + 1] : []));
		const stbl = box(
			'stbl',
			fullBox(
				'stsd',
				0,
				0,
				fields([32, 1]),
				box(
					'av01',
					new Uint8Array(6), // reserved
					fields([16, 1], [16, 0], [16, 0], [32, 0], [32, 0], [32, 0]),
					fields([16, width], [16, height], [32, 0x00480000], [32, 0x00480000], [32, 0], [16, 1]),
					new Uint8Array(32), // compressor name
					fields([16, 0x0018], [16, 0xffff]),
					av1C,
					colr,
					// Coding constraints: not all intra, intra prediction used, up to 15 references.
					fullBox('ccst', 0, 0, [0b0111_1100, 0, 0, 0])
				)
			),
			fullBox('stts', 0, 0, ...timeToSample(samples)),
			fullBox('stsc', 0, 0, fields([32, 1], [32, 1], [32, samples.length], [32, 1])),
			fullBox(
				'stsz',
				0,
				0,
				fields([32, 0], [32, samples.length]),
				fields(...samples.map((s): [32, number] => [32, s.data.length]))
			),
			fullBox('stco', 0, 0, fields([32, 1], [32, mdatAt])),
			...(sync.length < samples.length
				? [
						fullBox(
							'stss',
							0,
							0,
							fields([32, sync.length], ...sync.map((n): [32, number] => [32, n]))
						)
					]
				: [])
		);
		const moov = box(
			'moov',
			fullBox(
				'mvhd',
				1,
				0,
				fields(
					[64, 0],
					[64, 0],
					[32, timescale],
					[64, INDEFINITE],
					[32, 0x00010000],
					[16, 0x0100],
					[16, 0],
					[32, 0],
					[32, 0]
				),
				UNITY_MATRIX,
				new Uint8Array(24),
				fields([32, 2])
			),
			box(
				'trak',
				fullBox(
					'tkhd',
					1,
					1, // enabled
					fields(
						[64, 0],
						[64, 0],
						[32, 1],
						[32, 0],
						[64, INDEFINITE],
						[32, 0],
						[32, 0],
						[16, 0],
						[16, 0],
						[16, 0],
						[16, 0]
					),
					UNITY_MATRIX,
					fields([32, width * 0x10000], [32, height * 0x10000])
				),
				// One edit of the whole track, repeated: the animation loops forever.
				box('edts', fullBox('elst', 1, 1, fields([32, 1], [64, total], [64, 0], [16, 1], [16, 0]))),
				box(
					'mdia',
					fullBox(
						'mdhd',
						1,
						0,
						fields(
							[64, 0],
							[64, 0],
							[32, timescale],
							[64, total],
							[16, LANGUAGE_UNDETERMINED],
							[16, 0]
						)
					),
					handler(),
					box(
						'minf',
						fullBox('vmhd', 0, 1, new Uint8Array(8)),
						box('dinf', fullBox('dref', 0, 0, fields([32, 1]), fullBox('url ', 0, 1))),
						stbl
					)
				)
			)
		);
		return [meta, moov];
	};

	const headerSize = (parts: Uint8Array[]) => parts.reduce((n, p) => n + p.length, 0);
	const mdatAt = ftyp.length + headerSize(layout(0)) + 8;
	const [meta, moov] = layout(mdatAt);
	const payload = samples.reduce((n, s) => n + s.data.length, 0);
	const mdat = new Uint8Array(8);
	new DataView(mdat.buffer).setUint32(0, 8 + payload);
	mdat.set(ascii('mdat'), 4);
	return [ftyp, meta, moov, mdat, ...samples.map((s) => s.data as Uint8Array<ArrayBuffer>)];
}

/** stts entries: runs of equal durations. */
function timeToSample(samples: Sample[]): Uint8Array[] {
	const runs: [count: number, delta: number][] = [];
	for (const s of samples) {
		const last = runs.at(-1);
		if (last && last[1] === s.duration) last[0]++;
		else runs.push([1, s.duration]);
	}
	return [
		fields([32, runs.length]),
		...runs.map(([count, delta]) => fields([32, count], [32, delta]))
	];
}

export class AvifEncoder {
	readonly #width: number;
	readonly #height: number;
	readonly #fps: number;
	readonly #encoder: Av1Encoder;
	#index = 0;

	constructor({ width, height, fps, encoder }: AvifOptions) {
		this.#width = width;
		this.#height = height;
		this.#fps = fps;
		this.#encoder = encoder;
	}

	/** Adds a width × height frame of RGBA pixels, shown for 1/fps s. The first is a key frame. */
	async addFrame(rgba: Uint8ClampedArray): Promise<void> {
		const [width, height] = [this.#width, this.#height];
		if (rgba.length !== width * height * 4) {
			throw new RangeError(
				`expected a ${width} × ${height} frame (${width * height * 4} bytes), got ${rgba.length} bytes`
			);
		}
		const index = this.#index++;
		await this.#encoder.encode(rgba, Math.round((index * 1e6) / this.#fps), index === 0);
	}

	/** The AVIF file's bytes, in order. */
	async finish(): Promise<Uint8Array<ArrayBuffer>[]> {
		const { chunks, colorSpace, description = null } = await this.#encoder.finish();
		const tick = 1e6 / this.#fps;
		const end = this.#index * tick;
		// Each sample lasts until the next one: a frame the encoder dropped lengthens the one before.
		const samples = chunks.map((chunk, i): Sample => ({
			data: stripForIsobmff(chunk.data),
			sync: chunk.key,
			duration: Math.max(
				1,
				Math.round(((chunks[i + 1]?.timestamp ?? end) - chunk.timestamp) / tick)
			)
		}));
		return muxAvif(
			{ width: this.#width, height: this.#height, timescale: this.#fps },
			samples,
			colorSpace,
			description
		);
	}
}

/** Most chunks in the encoder's queue before `encode` waits for it to catch up. */
const MAX_QUEUE = 4;

interface Av1Settings {
	width: number;
	height: number;
	fps: number;
	/** 1-100. */
	quality: number;
}

/** VideoEncoder.encode() options, with the AV1 ones TypeScript's DOM types leave out. */
export type Av1EncodeOptions = VideoEncoderEncodeOptions & { av1?: { quantizer?: number } };

/** What av1Encoding uses of WebCodecs: the browser's, or a test's. */
export interface Av1Platform {
	VideoEncoder?: {
		isConfigSupported(config: VideoEncoderConfig): Promise<VideoEncoderSupport>;
		new (init: VideoEncoderInit): {
			encode(frame: never, options?: Av1EncodeOptions): void;
			close(): void;
		};
	};
	VideoFrame?: new (data: AllowSharedBufferSource, init: VideoFrameBufferInit) => { close(): void };
}

/**
 * Whether this browser's encode() takes per-frame AV1 options — and so a
 * quantizer, with `bitrateMode: 'quantizer'`. Firefox accepts that mode but
 * has no `av1` options: it encodes at a variable bitrate with no target,
 * whatever the quantizer. WebIDL converts the options before encode() looks
 * at the encoder's state, reading only the members this browser knows, so an
 * unconfigured encoder tells: it refuses, after reading `av1` or not.
 */
function takesAv1Quantizers({ VideoEncoder, VideoFrame }: Required<Av1Platform>): boolean {
	let read = false;
	const frame = new VideoFrame(new Uint8Array(2 * 2 * 4), {
		format: 'RGBA',
		codedWidth: 2,
		codedHeight: 2,
		timestamp: 0
	});
	try {
		const encoder = new VideoEncoder({ output() {}, error() {} });
		try {
			encoder.encode(frame as never, {
				get av1() {
					read = true;
					return {};
				}
			});
		} catch {
			// Not configured: the answer is already in.
		} finally {
			encoder.close();
		}
	} finally {
		frame.close();
	}
	return read;
}

/**
 * Bits per pixel per frame for a quality of 1-100, where the encoder takes a
 * bitrate only: about what Chromium's AV1 makes of the fixture clip at that
 * quality's quantizer (0.51 at 50, 0.75 at 75, 1.2 at 100).
 */
const bitsPerPixel = (quality: number) => 0.2 + quality ** 2 / 10_000;

/**
 * The encoder configuration this browser accepts for AV1 at this size, and
 * the per-frame quantizer for `quality` where it takes one (0 best, 63
 * smallest; a bitrate otherwise). Null when it cannot encode AV1.
 *
 * Every frame is encoded, each predicted only from frames before it, in
 * every browser — what latency mode gives that differs. Chromium's encoder
 * never looks ahead, and may drop frames in 'realtime' mode only. Firefox's
 * never drops frames, and looks ahead in 'quality' mode, predicting frames
 * from filtered future ones (short of bits, a frame can come out nearer the
 * next one than itself). Firefox is the browser without per-frame options,
 * so they tell which.
 */
export async function av1Encoding(
	{ width, height, fps, quality }: Av1Settings,
	platform: Av1Platform = globalThis
): Promise<{ config: VideoEncoderConfig; quantizer: number | null } | null> {
	const { VideoEncoder, VideoFrame } = platform;
	if (typeof VideoEncoder !== 'function' || typeof VideoFrame !== 'function') return null;
	const base: VideoEncoderConfig = { codec: 'av01.0.08M.08', width, height, framerate: fps };
	const bitrate = Math.round(width * height * fps * bitsPerPixel(quality));
	const byQuantizer: VideoEncoderConfig = {
		...base,
		latencyMode: 'quality',
		bitrateMode: 'quantizer'
	};
	const byBitrate = (latencyMode: LatencyMode): VideoEncoderConfig => ({
		...base,
		latencyMode,
		bitrateMode: 'variable',
		bitrate
	});
	let quantizers: boolean;
	try {
		quantizers = takesAv1Quantizers({ VideoEncoder, VideoFrame });
	} catch {
		return null; // No RGBA frames to encode (or no encoder to give them to).
	}
	const choices = quantizers
		? [byQuantizer, byBitrate('quality')]
		: [byBitrate('realtime'), byBitrate('quality')];
	for (const config of choices) {
		const support = await VideoEncoder.isConfigSupported(config).catch(() => null);
		if (support?.supported) {
			const quantizer = config === byQuantizer ? Math.round(((100 - quality) * 63) / 100) : null;
			return { config, quantizer };
		}
	}
	return null;
}

/** Whether this browser can encode AV1 (asked at a typical size). */
export async function av1Supported(): Promise<boolean> {
	return (await av1Encoding({ width: 480, height: 270, fps: 12, quality: 75 })) !== null;
}

/**
 * The browser's AV1 encoder (WebCodecs), at the quality asked for (see
 * av1Encoding). Null when this browser cannot encode AV1 at this size.
 */
export async function webCodecsAv1(settings: Av1Settings): Promise<Av1Encoder | null> {
	const encoding = await av1Encoding(settings);
	if (!encoding) return null;
	const { config, quantizer } = encoding;
	const { width, height, fps } = settings;
	const output: Av1Output = { chunks: [], colorSpace: null };
	let failure: Error | null = null;
	const encoder = new VideoEncoder({
		output(chunk, metadata) {
			const data = new Uint8Array(chunk.byteLength);
			chunk.copyTo(data);
			output.chunks.push({ data, key: chunk.type === 'key', timestamp: chunk.timestamp });
			const config = metadata?.decoderConfig;
			if (config?.colorSpace) output.colorSpace = config.colorSpace;
			if (config?.description) {
				const d = config.description;
				output.description = ArrayBuffer.isView(d)
					? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice()
					: new Uint8Array(d).slice();
			}
		},
		error(e) {
			failure = e;
		}
	});
	encoder.configure(config);
	return {
		async encode(pixels, timestamp, keyFrame) {
			if (failure) throw failure;
			const frame = new VideoFrame(pixels, {
				format: 'RGBA',
				codedWidth: width,
				codedHeight: height,
				timestamp,
				duration: Math.round(1e6 / fps)
			});
			try {
				const options: Av1EncodeOptions = { keyFrame };
				if (quantizer !== null) options.av1 = { quantizer };
				encoder.encode(frame, options);
			} finally {
				frame.close();
			}
			// Software AV1 is slower than taking frames: keep the queue (and its memory) short.
			while (encoder.encodeQueueSize > MAX_QUEUE && !failure) {
				// 'dequeue' says when; the timer re-checks where a browser never says.
				await new Promise((resolve) => {
					encoder.addEventListener('dequeue', resolve, { once: true });
					setTimeout(resolve, 50);
				});
			}
		},
		async finish() {
			await encoder.flush();
			encoder.close();
			if (failure) throw failure;
			return output;
		}
	};
}
