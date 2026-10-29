/**
 * The animate worker: frames the page took from a video, encoded into an
 * animated GIF (src/lib/animate/gif.ts) off the main thread.
 *
 * It only ever sees RGBA pixels the browser has already decoded — never the
 * video file — and touches no storage and no network. The page starts one
 * per animation and stops it when the GIF is out.
 */
import { animateHandlers } from '$lib/animate/encoder';
import { serveWorker } from '$lib/workers/protocol';

serveWorker(animateHandlers());
