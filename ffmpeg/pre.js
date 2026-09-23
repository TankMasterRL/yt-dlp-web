// @ts-nocheck — Emscripten runtime code: `Module`, `_remux_exec` and the
// helpers below exist only inside the module factory this is compiled into.
//
// The remux core's JavaScript interface (emcc --pre-js): the slice of
// @ffmpeg/core's that yt-dlp-web's remux worker uses, so either core can be
// served. exec(...args) runs remux.c on an ffmpeg-style command line and
// returns its exit code; setLogger(fn) receives what it prints, line by line;
// FS is Emscripten's filesystem. There is no ffprobe.

let logger = () => {};
/** Set once the wasm has trapped: its memory can no longer be trusted. */
let crashed = null;

Module['print'] = (message) => logger({ type: 'stdout', message });
Module['printErr'] = (message) => logger({ type: 'stderr', message });

Module['setLogger'] = (next) => {
	logger = next;
};

/** Nothing carries over from one run to the next. */
Module['reset'] = () => {};

Module['exec'] = (...args) => {
	if (crashed) throw new Error(`ffmpeg crashed in an earlier run: ${crashed}`);
	const strings = args.map((arg) => stringToNewUTF8(String(arg)));
	const argv = _malloc(strings.length * 4);
	strings.forEach((pointer, i) => {
		HEAPU32[(argv >> 2) + i] = pointer;
	});
	let code;
	try {
		code = _remux_exec(strings.length, argv);
	} catch (error) {
		crashed = error instanceof Error ? error.message : String(error);
		throw error;
	}
	for (const pointer of strings) _free(pointer);
	_free(argv);
	return code;
};
