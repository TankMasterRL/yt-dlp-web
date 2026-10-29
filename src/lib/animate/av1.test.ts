// @vitest-environment node
import { describe, expect, it } from 'vitest';
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
		// profile 0, not still, full header: timing info (with equal picture
		// intervals), no decoder model, one operating point at level 5, 7-bit
		// frame sizes, then the colour config with BT.709 primaries, sRGB
		// transfer, BT.709 matrix, full range.
		const bits: number[] = [];
		const put = (n: number, v: number) => {
			for (let i = n - 1; i >= 0; i--) bits.push((v / 2 ** i) & 1);
		};
		put(3, 0); // seq_profile
		put(1, 0); // still_picture
		put(1, 0); // reduced_still_picture_header
		put(1, 1); // timing_info_present_flag
		put(32, 1); // num_units_in_display_tick
		put(32, 30); // time_scale
		put(1, 1); // equal_picture_interval
		put(1, 1); // num_ticks_per_picture_minus_1 = 0, as uvlc: a single 1
		put(1, 0); // decoder_model_info_present_flag
		put(1, 0); // initial_display_delay_present_flag
		put(5, 0); // operating_points_cnt_minus_1
		put(12, 0); // operating_point_idc[0]
		put(5, 5); // seq_level_idx[0] (≤ 7: no tier bit)
		put(4, 6); // frame_width_bits_minus_1
		put(4, 6); // frame_height_bits_minus_1
		put(7, 63); // max_frame_width_minus_1
		put(7, 35); // max_frame_height_minus_1
		put(1, 0); // frame_id_numbers_present_flag
		put(3, 0); // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter
		put(4, 0); // interintra, masked compound, warped motion, dual filter
		put(1, 0); // enable_order_hint
		put(1, 1); // seq_choose_screen_content_tools (→ SELECT)
		put(1, 1); // seq_choose_integer_mv (→ SELECT)
		put(3, 0); // enable_superres, enable_cdef, enable_restoration
		put(1, 0); // high_bitdepth
		put(1, 0); // mono_chrome
		put(1, 1); // color_description_present_flag
		put(8, 1); // color_primaries
		put(8, 13); // transfer_characteristics
		put(8, 1); // matrix_coefficients
		put(1, 1); // color_range
		put(2, 2); // chroma_sample_position (4:2:0 in profile 0)
		while (bits.length % 8) bits.push(0);
		const bytes = Uint8Array.from({ length: bits.length / 8 }, (_, i) =>
			bits.slice(i * 8, i * 8 + 8).reduce((b, bit) => (b << 1) | bit, 0)
		);
		expect(parseSequenceHeader(Uint8Array.from(obu(1, [...bytes])))).toMatchObject({
			level: 5,
			tier: 0,
			colorDescription: { primaries: 1, transfer: 13, matrix: 1 },
			fullRange: true,
			subsamplingX: 1,
			subsamplingY: 1,
			chromaSamplePosition: 2
		});
	});

	it('builds the av1C configuration from the sequence header', () => {
		const config = av1Config(SEQUENCE_HEADER);
		// marker + version 1; profile 0, level 0; tier 0, 8-bit, 4:2:0, unknown sample position; no delay.
		expect([...config.subarray(0, 4)]).toEqual([0x81, 0x00, 0b0000_1100, 0]);
		expect([...config.subarray(4)]).toEqual([...SEQUENCE_HEADER]);
	});
});
