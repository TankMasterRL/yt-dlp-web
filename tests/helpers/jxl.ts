/**
 * JPEG XL decoding for tests, by jxl-oxide (a decoder independent of the
 * app's encoder, in WebAssembly): every animation keyframe, its duration and
 * its pixels. Errors carry jxl-oxide's reason, which says what in the
 * codestream it could not accept.
 */
import { readFileSync } from 'node:fs';
import { initSync, JxlImage } from 'jxl-oxide-wasm';
import { decodePng } from './apng';

export interface DecodedJxl {
	width: number;
	height: number;
	animated: boolean;
	loops: number | undefined;
	frames: {
		/**
		 * The frame's ticks times the image's ticks per second. jxl-oxide-wasm
		 * 0.12.6 reports this as `duration`: its binding multiplies by
		 * tps_numerator / tps_denominator where it should divide (jxl-oxide's own
		 * AnimationHeader documents tps as ticks per second). Divide by the tps
		 * the test wrote to get ticks.
		 */
		ticksTimesTps: number;
		pixels: Uint8ClampedArray;
	}[];
}

let ready = false;

export function decodeJxl(bytes: Uint8Array): DecodedJxl {
	if (!ready) {
		const wasm = new URL(
			'../../node_modules/jxl-oxide-wasm/jxl_oxide_wasm_bg.wasm',
			import.meta.url
		);
		initSync({ module: readFileSync(wasm) });
		ready = true;
	}
	const image = new JxlImage();
	try {
		image.feedBytes(bytes);
		if (!image.tryInit()) throw new Error('jxl-oxide: the headers are incomplete');
		if (!image.loaded) throw new Error('jxl-oxide: the codestream is incomplete');
		const frames = Array.from({ length: image.numLoadedKeyframes }, (_, i) => {
			const result = image.render(i);
			const ticksTimesTps = result.duration;
			// encodeToPng() consumes the result: nothing to free afterwards.
			return { ticksTimesTps, pixels: decodePng(result.encodeToPng()).pixels };
		});
		return {
			width: image.width!,
			height: image.height!,
			animated: image.animated ?? false,
			loops: image.numLoops,
			frames
		};
	} finally {
		image.free();
	}
}
