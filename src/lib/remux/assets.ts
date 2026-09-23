/**
 * Where the app serves its FFmpeg core when the build includes one:
 * scripts/sync-assets.ts copies ffmpeg.wasm (`@ffmpeg/core`, GPL-2.0-or-later)
 * or, with YT_DLP_WEB_FFMPEG=remux, the remux core (LGPL-2.1-or-later) into
 * static/ffmpeg/ — under the same file names — and neither with
 * YT_DLP_WEB_FFMPEG=0.
 */
export const FFMPEG_DIR = 'ffmpeg/';
export const FFMPEG_CORE_JS = 'ffmpeg-core.js';
export const FFMPEG_CORE_WASM = 'ffmpeg-core.wasm';
