/**
 * AV1 sequence header OBUs written bit by bit from the spec (5.5), for tests
 * that need a stream to say something about itself — its colours above all.
 *
 * Profile 0, not still, the full header: timing info (equal picture
 * intervals), no decoder model, one operating point at level 5, 7-bit frame
 * sizes for 64 × 36, no frame ids or coding tools, then the colour config.
 */
export interface SequenceHeaderColour {
	/** CICP primaries, transfer and matrix; null writes no colour description. */
	colorDescription?: { primaries: number; transfer: number; matrix: number } | null;
	fullRange?: boolean;
}

export function sequenceHeaderObu({
	colorDescription = { primaries: 1, transfer: 13, matrix: 1 },
	fullRange = true
}: SequenceHeaderColour = {}): Uint8Array {
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
	put(1, colorDescription ? 1 : 0); // color_description_present_flag
	if (colorDescription) {
		put(8, colorDescription.primaries);
		put(8, colorDescription.transfer);
		put(8, colorDescription.matrix);
	}
	put(1, fullRange ? 1 : 0); // color_range
	put(2, 2); // chroma_sample_position (4:2:0 in profile 0)
	while (bits.length % 8) bits.push(0); // separate_uv_delta_q, film grain: off
	const payload = Array.from({ length: bits.length / 8 }, (_, i) =>
		bits.slice(i * 8, i * 8 + 8).reduce((b, bit) => (b << 1) | bit, 0)
	);
	// OBU header: OBU_SEQUENCE_HEADER (1) with a size field.
	return Uint8Array.from([(1 << 3) | 0b10, payload.length, ...payload]);
}
