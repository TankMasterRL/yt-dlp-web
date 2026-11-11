// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { sequenceHeaderObu } from '../../../tests/helpers/av1';
import { av1Config, parseSequenceHeader, readObus, stripForIsobmff } from './av1';

/** The first key chunk Chromium's VideoEncoder made for 64×36 'av01.0.08M.08' (truncated). */
const CHROMIUM_KEY = Uint8Array.from([
	18, 0, 10, 12, 0, 0, 0, 2, 175, 241, 128, 52, 64, 67, 64, 97, 50, 29, 16, 72, 0, 4, 16, 65
]);
const SEQUENCE_HEADER = CHROMIUM_KEY.subarray(2, 16);

/** OBU: header byte (type, has_size_field), leb128 size, payload. */
function obu(type: number, payload: number[]): number[] {
	return [(type << 3) | 0b10, payload.length, ...payload];
}

describe('AV1 OBUs', () => {
	it('splits a temporal unit into its OBUs', () => {
		const obus = readObus(CHROMIUM_KEY);
		expect(obus.slice(0, 2).map((o) => [o.type, o.size])).toEqual([
			[2, 0],
			[1, 12]
		]);
		expect(obus[2].type).toBe(6); // OBU_FRAME, cut short here
	});

	it('drops temporal delimiters and padding, as samples in MP4 and AVIF must', () => {
		const unit = Uint8Array.from([
			...obu(2, []),
			...obu(1, [7, 7]),
			...obu(15, [0, 0]),
			...obu(6, [9])
		]);
		expect([...stripForIsobmff(unit)]).toEqual([...obu(1, [7, 7]), ...obu(6, [9])]);
	});

	it('reads a real sequence header: profile, level, tier and colour format', () => {
		// libaom states the level the stream needs (2.0 for 64×36), not the codec string's.
		expect(parseSequenceHeader(SEQUENCE_HEADER)).toMatchObject({
			profile: 0,
			level: 0,
			tier: 0,
			highBitdepth: false,
			twelveBit: false,
			monochrome: false,
			subsamplingX: 1,
			subsamplingY: 1
		});
	});

	it('reads colour description and timing info when present', () => {
		// BT.709 primaries, sRGB transfer, BT.709 matrix, full range (see the helper).
		expect(parseSequenceHeader(sequenceHeaderObu())).toMatchObject({
			level: 5,
			tier: 0,
			colorDescription: { primaries: 1, transfer: 13, matrix: 1 },
			fullRange: true,
			subsamplingX: 1,
			subsamplingY: 1,
			chromaSamplePosition: 2
		});
	});

	it('reads a colour config with no colour description: unspecified, and the range bit', () => {
		expect(
			parseSequenceHeader(sequenceHeaderObu({ colorDescription: null, fullRange: false }))
		).toMatchObject({ colorDescription: null, fullRange: false });
	});

	it('builds the av1C configuration from the sequence header', () => {
		const config = av1Config(SEQUENCE_HEADER);
		// marker + version 1; profile 0, level 0; tier 0, 8-bit, 4:2:0, unknown sample position; no delay.
		expect([...config.subarray(0, 4)]).toEqual([0x81, 0x00, 0b0000_1100, 0]);
		expect([...config.subarray(4)]).toEqual([...SEQUENCE_HEADER]);
	});
});
