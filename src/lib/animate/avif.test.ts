// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { sequenceHeaderObu, type SequenceHeaderColour } from '../../../tests/helpers/av1';
import { readAvif } from '../../../tests/helpers/isobmff';
import { av1Config } from './av1';
import {
	AvifEncoder,
	av1Encoding,
	type Av1EncodeOptions,
	type Av1Encoder,
	type Av1Output
} from './avif';
import { rgbaToI420, type I420Frame } from './yuv';

/** Chromium's sequence header OBU for a 64×36 stream (see av1.test.ts). */
const SEQUENCE_HEADER = [10, 12, 0, 0, 0, 2, 175, 241, 128, 52, 64, 67, 64, 97];
const TEMPORAL_DELIMITER = [0x12, 0];
/** A frame OBU whose payload says which frame it was. */
const frameObu = (n: number) => [(6 << 3) | 0b10, 2, 0xf0, n];

/**
 * An AV1 encoder that makes Chromium-shaped temporal units: a delimiter, the
 * sequence header on key frames (`colour` makes one that says that), then
 * the frame. `drop` loses frames, as a real encoder may.
 */
function fakeAv1(options: { drop?: number[]; colour?: SequenceHeaderColour } = {}) {
	const output: Av1Output = { chunks: [] };
	const header = options.colour ? [...sequenceHeaderObu(options.colour)] : SEQUENCE_HEADER;
	let n = 0;
	const encoder: Av1Encoder & { keyFrames: boolean[]; frames: I420Frame[] } = {
		keyFrames: [],
		frames: [],
		async encode(frame, timestamp, keyFrame) {
			encoder.keyFrames.push(keyFrame);
			encoder.frames.push(frame);
			const index = n++;
			if (options.drop?.includes(index)) return;
			const data = Uint8Array.from([
				...TEMPORAL_DELIMITER,
				...(keyFrame ? header : []),
				...frameObu(index)
			]);
			output.chunks.push({ data, key: keyFrame || index === 4, timestamp });
		},
		async finish() {
			return output;
		}
	};
	return encoder;
}

const pixels = (width: number, height: number) => new Uint8ClampedArray(width * height * 4);

async function encode(frames: number, fps: number, av1: Av1Encoder = fakeAv1()) {
	const encoder = new AvifEncoder({ width: 64, height: 36, fps, encoder: av1 });
	for (let i = 0; i < frames; i++) await encoder.addFrame(pixels(64, 36));
	const chunks = await encoder.finish();
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	chunks.reduce((at, c) => (out.set(c, at), at + c.length), 0);
	return readAvif(out);
}

describe('AvifEncoder', () => {
	it('asks for one key frame, then lets the encoder predict', async () => {
		const av1 = fakeAv1();
		await encode(5, 10, av1);
		expect(av1.keyFrames).toEqual([true, false, false, false, false]);
	});

	it('brands the file an AVIF image sequence', async () => {
		const avif = await encode(3, 12);
		expect(avif.brands).toEqual({
			major: 'avis',
			compatible: ['avif', 'avis', 'msf1', 'iso8', 'mif1', 'miaf', 'MA1B']
		});
	});

	it('carries each temporal unit as a sample, without its temporal delimiter', async () => {
		const avif = await encode(6, 12);
		expect(avif.track.samples.map((s) => [...s])).toEqual([
			[...SEQUENCE_HEADER, ...frameObu(0)],
			...[1, 2, 3, 4, 5].map((i) => frameObu(i))
		]);
		// Key frames are sync samples, numbered from 1.
		expect(avif.track.sync).toEqual([1, 5]);
	});

	it('times samples in ticks of 1/fps, and loops forever', async () => {
		const avif = await encode(4, 12);
		expect(avif.movie).toEqual({ timescale: 12, duration: 2n ** 64n - 1n });
		expect(avif.track).toMatchObject({
			timescale: 12,
			durations: [1, 1, 1, 1],
			mediaDuration: 4n,
			duration: 2n ** 64n - 1n,
			repeat: true,
			segment: 4n,
			width: 64,
			height: 36,
			handler: 'pict'
		});
	});

	it('gives a dropped frame’s time to the frame before it', async () => {
		const avif = await encode(5, 10, fakeAv1({ drop: [2] }));
		expect(avif.track.durations).toEqual([1, 2, 1, 1]);
		expect(avif.track.mediaDuration).toBe(5n);
	});

	it('describes the stream: an av01 sample entry with av1C, colr and ccst', async () => {
		const avif = await encode(2, 10);
		expect(avif.track.sampleEntry).toEqual({
			type: 'av01',
			width: 64,
			height: 36,
			boxes: ['av1C', 'colr', 'ccst']
		});
		expect([...avif.track.av1C]).toEqual([...av1Config(Uint8Array.from(SEQUENCE_HEADER))]);
	});

	it('hands the encoder its frames as I420, converted here', async () => {
		const av1 = fakeAv1();
		const encoder = new AvifEncoder({ width: 5, height: 3, fps: 10, encoder: av1 });
		const frame = Uint8ClampedArray.from({ length: 5 * 3 * 4 }, (_, i) => (i * 37) % 256);
		await encoder.addFrame(frame);
		expect(av1.frames).toEqual([rgbaToI420(frame, 5, 3)]);
		expect(av1.frames[0]).toMatchObject({ codedWidth: 6, codedHeight: 4 });
	});

	// 'nclx', primaries BT.709, transfer sRGB, matrix BT.709, full range.
	const NCLX_OF_THE_CONVERSION = [0x6e, 0x63, 0x6c, 0x78, 0, 1, 0, 13, 0, 1, 0x80];

	it('states the colour the frames were converted with, in nclx', async () => {
		const avif = await encode(2, 10);
		expect([...avif.track.colr!]).toEqual(NCLX_OF_THE_CONVERSION);
		expect([...avif.properties[3].data]).toEqual(NCLX_OF_THE_CONVERSION);
	});

	it('states it where the stream itself says nothing of colour (as Firefox’s did)', async () => {
		const avif = await encode(2, 10, fakeAv1({ colour: { colorDescription: null } }));
		expect([...avif.track.colr!]).toEqual(NCLX_OF_THE_CONVERSION);
	});

	it('refuses a stream whose encoder changed the colours it was given', async () => {
		for (const colour of [
			{ fullRange: false },
			{ colorDescription: { primaries: 1, transfer: 13, matrix: 6 } }
		]) {
			await expect(encode(2, 10, fakeAv1({ colour }))).rejects.toThrow(/colours/);
		}
	});

	it('makes the first frame the primary image, for readers of still AVIF', async () => {
		const avif = await encode(3, 10);
		expect(avif.primaryItem).toBe(1);
		expect(avif.item).toMatchObject({ id: 1, type: 'av01' });
		const [first] = avif.track.samples;
		expect(avif.item.length).toBe(first.length);
		expect(avif.item.offset).toBe(first.byteOffset);
		expect(avif.properties.map((p) => [p.type, p.essential])).toEqual([
			['ispe', false],
			['pixi', false],
			['av1C', true],
			['colr', false]
		]);
		const ispe = new DataView(avif.properties[0].data.buffer, avif.properties[0].data.byteOffset);
		expect([ispe.getUint32(4), ispe.getUint32(8)]).toEqual([64, 36]);
		expect([...avif.properties[1].data]).toEqual([0, 0, 0, 0, 3, 8, 8, 8]);
	});

	it('takes the sequence header from the encoder’s av1C where the stream leaves it out', async () => {
		const description = av1Config(Uint8Array.from(SEQUENCE_HEADER));
		const encoder: Av1Encoder = {
			async encode() {},
			async finish() {
				return {
					chunks: [{ data: Uint8Array.from(frameObu(0)), key: true, timestamp: 0 }],
					description
				};
			}
		};
		const avif = new AvifEncoder({ width: 64, height: 36, fps: 10, encoder });
		await avif.addFrame(pixels(64, 36));
		const chunks = await avif.finish();
		const file = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
		chunks.reduce((at, c) => (file.set(c, at), at + c.length), 0);
		expect([...readAvif(file).track.av1C]).toEqual([...description]);
	});

	it('refuses a stream that does not start with a key frame and its sequence header', async () => {
		const noHeader: Av1Encoder = {
			async encode() {},
			async finish() {
				return { chunks: [{ data: Uint8Array.from(frameObu(0)), key: true, timestamp: 0 }] };
			}
		};
		const encoder = new AvifEncoder({ width: 64, height: 36, fps: 10, encoder: noHeader });
		await encoder.addFrame(pixels(64, 36));
		await expect(encoder.finish()).rejects.toThrow(/sequence header/);
	});
});

/**
 * A browser's VideoEncoder as av1Encoding sees it. Its encode() converts the
 * options as WebIDL does — reading only the members this browser knows — and
 * then, unconfigured, refuses. `av1` names a browser with per-frame AV1
 * options (Chromium); without it, one that has none (Firefox).
 */
function fakeWebCodecs({
	av1,
	supports = () => true
}: {
	av1: boolean;
	supports?: (config: VideoEncoderConfig) => boolean;
}) {
	const asked: VideoEncoderConfig[] = [];
	const closed = { encoders: 0, frames: 0 };
	class FakeVideoEncoder {
		static async isConfigSupported(config: VideoEncoderConfig) {
			asked.push(config);
			return { supported: supports(config), config };
		}
		constructor(_init: VideoEncoderInit) {}
		encode(_frame: unknown, options: Av1EncodeOptions = {}) {
			void (av1 ? [options.av1, options.keyFrame] : [options.keyFrame]);
			throw new DOMException('not configured', 'InvalidStateError');
		}
		close() {
			closed.encoders++;
		}
	}
	class FakeVideoFrame {
		constructor(_data: AllowSharedBufferSource, _init: VideoFrameBufferInit) {}
		close() {
			closed.frames++;
		}
	}
	return {
		platform: { VideoEncoder: FakeVideoEncoder, VideoFrame: FakeVideoFrame },
		asked,
		closed
	};
}

describe('av1Encoding', () => {
	const settings = { width: 320, height: 180, fps: 10, quality: 75 };

	it('sets a quantizer from the quality where encode() takes per-frame AV1 options', async () => {
		const { platform, closed } = fakeWebCodecs({ av1: true });
		const encoding = await av1Encoding(settings, platform);
		expect(encoding).toEqual({
			config: expect.objectContaining({
				codec: 'av01.0.08M.08',
				width: 320,
				height: 180,
				framerate: 10,
				bitrateMode: 'quantizer',
				latencyMode: 'quality'
			}),
			quantizer: 16
		});
		// The probe's encoder and frame are let go.
		expect(closed).toEqual({ encoders: 1, frames: 1 });
	});

	it('encodes at a bitrate from the quality where encode() has no AV1 options', async () => {
		// Firefox accepts bitrateMode 'quantizer' but has no `av1` encode options:
		// it would encode at a variable bitrate with no target, whatever the quality.
		const { platform } = fakeWebCodecs({ av1: false });
		const encoding = await av1Encoding(settings, platform);
		expect(encoding).toEqual({
			config: expect.objectContaining({
				bitrateMode: 'variable',
				latencyMode: 'quality',
				// 0.2 + q²/10⁴ bits per pixel per frame: what Chromium's quantizers make.
				bitrate: Math.round(320 * 180 * 10 * (0.2 + 0.5625))
			}),
			quantizer: null
		});
	});

	it('spends more bits for more quality', async () => {
		const { platform } = fakeWebCodecs({ av1: false });
		const bitrates = await Promise.all(
			[50, 75, 100].map(
				async (quality) => (await av1Encoding({ ...settings, quality }, platform))!.config.bitrate
			)
		);
		expect(bitrates).toEqual([0.45, 0.7625, 1.2].map((bpp) => Math.round(320 * 180 * 10 * bpp)));
	});

	it('falls back to a bitrate where the quantizer mode is refused, and to nothing without AV1', async () => {
		const noQuantizer = fakeWebCodecs({
			av1: true,
			supports: (c) => c.bitrateMode !== 'quantizer'
		});
		expect(await av1Encoding(settings, noQuantizer.platform)).toMatchObject({
			config: { bitrateMode: 'variable', latencyMode: 'quality' },
			quantizer: null
		});
		const noAv1 = fakeWebCodecs({ av1: true, supports: () => false });
		expect(await av1Encoding(settings, noAv1.platform)).toBeNull();
		expect(await av1Encoding(settings, {})).toBeNull();
	});

	it('makes no AV1 where the browser cannot make the I420 frames it would be given', async () => {
		const { platform } = fakeWebCodecs({ av1: true });
		const noRgba = {
			...platform,
			VideoFrame: class {
				constructor() {
					throw new TypeError('I420 is not supported');
				}
				close() {}
			}
		};
		expect(await av1Encoding(settings, noRgba)).toBeNull();
	});
});
