// @vitest-environment node
/**
 * The AVIF muxer with a REAL AV1 stream: the fixture clip's temporal units
 * (bbf-av1.mp4, recorded by Chromium's MediaRecorder), muxed into an AVIF
 * image sequence and read back by FFmpeg's own MP4/AVIF demuxer — the
 * stream it finds, and every sample, byte for byte. (FFmpeg 5.1 here has no
 * software AV1 decoder: Chromium decodes the frames in the e2e suite.)
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadFFmpegCore } from '../../../tests/helpers/ffmpeg';
import { concat, oracle } from '../../../tests/helpers/oracle';
import { OBU_SEQUENCE_HEADER, parseSequenceHeader, readObus, stripForIsobmff } from './av1';
import { muxAvif, type Sample } from './avif';

let ffmpeg: ReturnType<typeof oracle>;
beforeAll(async () => {
	ffmpeg = oracle(await loadFFmpegCore());
});

/** An OBU stream split at its temporal delimiters: one temporal unit per frame. */
function temporalUnits(stream: Uint8Array): Uint8Array[] {
	const units: Uint8Array[] = [];
	let start = -1;
	for (const obu of readObus(stream)) {
		if (obu.type !== 2) continue;
		if (start >= 0) units.push(stream.subarray(start, obu.start));
		start = obu.start;
	}
	units.push(stream.subarray(start));
	return units;
}

const fixture = new Uint8Array(
	readFileSync(new URL('../../../tests/fixtures/media/bbf-av1.mp4', import.meta.url))
);

describe('AVIF from a real AV1 stream', () => {
	it('is read back by FFmpeg: one AV1 stream of every frame, each sample intact', async () => {
		const stream = ffmpeg.withFile('clip.mp4', fixture, (path) => {
			ffmpeg.run(['-i', path, '-c:v', 'copy', '-f', 'obu', '/clip.obu']);
			return ffmpeg.take('/clip.obu');
		});
		const units = temporalUnits(stream);
		expect(units.length).toBeGreaterThan(10);
		const fps = 12;
		// Key frames are the units that carry a sequence header.
		const headerOf = (unit: Uint8Array) => {
			const obu = readObus(unit).find((o) => o.type === OBU_SEQUENCE_HEADER);
			return obu && unit.subarray(obu.start, obu.end);
		};
		const samples: Sample[] = units.map((unit) => ({
			data: stripForIsobmff(unit),
			sync: !!headerOf(unit),
			duration: 1
		}));
		// Its frames are in the colours its stream says (MediaRecorder's: BT.601,
		// limited range), not the app's conversion: the file says so too.
		const sequence = parseSequenceHeader(headerOf(units[0])!);
		const colour = { ...sequence.colorDescription!, fullRange: sequence.fullRange };
		expect(colour).toMatchObject({ matrix: 6, fullRange: false });
		const avif = concat(muxAvif({ width: 320, height: 180, timescale: fps }, samples, colour));

		expect(
			ffmpeg.probe(avif, 'avif', 'stream=codec_name,width,height,nb_frames,r_frame_rate')
		).toEqual([`av1,320,180,12/1,${units.length}`]);
		// FFmpeg pulls out exactly the samples that went in.
		const back = ffmpeg.withFile('anim.avif', avif, (path) => {
			ffmpeg.run(['-i', path, '-c:v', 'copy', '-f', 'obu', '/back.obu']);
			return ffmpeg.take('/back.obu');
		});
		expect(temporalUnits(back).map((u) => [...stripForIsobmff(u)])).toEqual(
			units.map((u) => [...stripForIsobmff(u)])
		);
	});
});
