/**
 * Where the app serves ffmpeg.wasm (`@ffmpeg/core`, GPL-2.0-or-later) when the
 * build includes it: scripts/sync-assets.ts copies it into static/ffmpeg/
 * unless YT_DLP_WEB_FFMPEG=0.
 */
export const FFMPEG_DIR = 'ffmpeg/';
export const FFMPEG_CORE_JS = 'ffmpeg-core.js';
export const FFMPEG_CORE_WASM = 'ffmpeg-core.wasm';
