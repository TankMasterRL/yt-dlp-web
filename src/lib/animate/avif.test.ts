// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readAvif } from '../../../tests/helpers/isobmff';
import { av1Config } from './av1';
import { AvifEncoder, type Av1Encoder, type Av1Output } from './avif';

/** Chromium's sequence header OBU for a 64×36 stream (see av1.test.ts). */
const SEQUENCE_HEADER = [10, 12, 0, 0, 0, 2, 175, 241, 128, 52, 64, 67, 64, 97];
const TEMPORAL_DELIMITER = [0x12, 0];
/** A frame OBU whose payload says which frame it was. */
const frameObu = (n: number) => [(6 << 3) | 0b10, 2, 0xf0, n];

/**
 * An AV1 encoder that makes Chromium-shaped temporal units: a delimiter, the
 * sequence header on key frames, then the frame. `drop` loses frames, as a
 * real encoder may.
 */
function fakeAv1(options: { drop?: number[]; colorSpace?: VideoColorSpaceInit | null } = {}) {
	const output: Av1Output = { chunks: [], colorSpace: options.colorSpace ?? null };
	let n = 0;
	const encoder: Av1Encoder & { keyFrames: boolean[] } = {
		keyFrames: [],
		async encode(_pixels, timestamp, keyFrame) {
			encoder.keyFrames.push(keyFrame);
			const index = n++;
			if (options.drop?.includes(index)) return;
			const data = Uint8Array.from([
				...TEMPORAL_DELIMITER,
				...(keyFrame ? SEQUENCE_HEADER : []),
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

	it('states the colour the encoder converted with, in nclx', async () => {
		const avif = await encode(
			2,
			10,
			fakeAv1({
				colorSpace: {
					primaries: 'bt709',
					transfer: 'iec61966-2-1',
					matrix: 'bt709',
					fullRange: true
				}
			})
		);
		// 'nclx', primaries 1, transfer 13, matrix 1, full range.
		expect([...avif.track.colr!]).toEqual([0x6e, 0x63, 0x6c, 0x78, 0, 1, 0, 13, 0, 1, 0x80]);
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
					colorSpace: null,
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
				return {
					chunks: [{ data: Uint8Array.from(frameObu(0)), key: true, timestamp: 0 }],
					colorSpace: null
				};
			}
		};
		const encoder = new AvifEncoder({ width: 64, height: 36, fps: 10, encoder: noHeader });
		await encoder.addFrame(pixels(64, 36));
		await expect(encoder.finish()).rejects.toThrow(/sequence header/);
	});
});
