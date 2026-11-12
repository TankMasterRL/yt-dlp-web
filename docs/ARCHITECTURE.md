# Architecture

yt-dlp-web runs the real yt-dlp in the browser. This page explains how, and why each piece
exists. For the security side of the same design see `SECURITY.md`; for the rules that keep the
code this way see `CLAUDE.md`.

## Why a server is still needed

Two things stop a web page from being yt-dlp on its own:

1. **CORS.** youtube.com sends no `Access-Control-Allow-Origin` to other sites, so a page may not
   read its watch pages, its API responses or its player script.
2. **JavaScript challenges.** YouTube obfuscates its stream URLs behind functions in its player
   script. yt-dlp solves them by running the player's code in an external JavaScript runtime
   (Deno, Node or QuickJS), and there are no subprocesses in Pyodide.

So a Cloudflare Worker does exactly those two jobs:

- **`/relay`**: one browser request becomes exactly one upstream request, restricted to an
  allowlist of hosts.
- **`/solve`**: the challenge program runs in a Dynamic Worker isolate with no network.

It holds no secrets, stores nothing and parses nothing. Everything else happens in the browser.

Only fetching needs it. A build without a relay (`VITE_RELAY_URL=none`) is still a library: it
imports videos from the device, plays and saves them, and makes animated images of them. Its
download page says the site has no relay, no engine starts, and the build ships no Pyodide, wheels
or FFmpeg. A build with a relay asks it what it can do when the engine boots (`GET /solve`: 204
solves, 501 only relays, anything else — an error, a static host's 404, a 403 for this origin —
is no relay answering this page), and says so when it does not answer.

## The pieces

```
page (Svelte 5)                     src/routes/, src/lib/ui/
 ├─ ExtractSession (runes)          src/lib/engine/session.svelte.ts
 │   └─ engine worker               src/workers/engine.worker.ts
 │       Pyodide + yt-dlp wheels    src/lib/engine/{runtime,wheels}.ts
 │       ytdlp_web (Python)         src/python/ytdlp_web/
 │         RelayRH ─────────────────▶ /relay   (sync XHR, src/lib/relay/client.ts)
 │         SandboxJCP ──────────────▶ /solve   (sync XHR)
 └─ Library (runes)                 src/lib/storage/library.svelte.ts
     ├─ IndexedDB metadata          src/lib/storage/db.ts
     ├─ download worker ────────────▶ /relay   (ranged fetch → OPFS)   src/workers/download.worker.ts
     │    imports: a picked File ───▶ OPFS                            src/lib/download/copy.ts
     ├─ imported files, opened first in a <video>                     src/lib/storage/{inspect,imported}.ts
     ├─ remux worker (on demand)    FFmpeg → OPFS                     src/workers/remux.worker.ts
     └─ animations (library page)   <video> frames → animate worker   src/lib/animate/, src/workers/animate.worker.ts

Worker                              worker/src/
 ├─ /relay   relay.ts + policy.ts (allowlist, SSRF guard)
 ├─ /solve   solve.ts + sandbox.ts (worker_loader isolate)
 └─ (all-in-one) the static app, via Workers Static Assets
```

Every worker speaks the same small protocol (`src/lib/workers/protocol.ts`). A `load` message may
report progress and ends in `ready` or `error`. Each piece of work carries an `id`, may report
progress, and ends in a `result` or `error` with that `id`. Errors keep their `name` across the
boundary, which is how the library tells a pause (`AbortError`) from a failure.

## yt-dlp in Pyodide

**Installing.** The engine worker loads Pyodide from the app's own origin (`static/pyodide/`).
yt-dlp has no required dependencies, so its wheel and the yt-dlp-ejs solver wheel are simply
unpacked with `pyodide.unpackArchive()`. There is no micropip and no PyPI at runtime. Before
unpacking, each wheel is checked against the SHA-256 pinned in `src/lib/engine/wheels.ts`.

**Starting quickly.** Booting is the longest wait in the app, so nothing in it waits for anything
it does not need. The wheels download and are checked while Pyodide starts, and the relay is
probed alongside (for at most 10 s); only installing yt-dlp waits for the probe. The page counts
the boot's three steps beside a busy sign. The session outlives the download page: back from the
library, yt-dlp is still running and the formats last found are still listed.

**Warming up.** A first extraction does seconds of one-time work (tens in Firefox): it compiles
extractor after extractor's URL pattern until one claims the URL, and on a page none claims it
imports every extractor module to look for embedded players. Once the engine is ready,
`api.warm_up()` does that work ahead of time, making the same calls on a blank page, so nothing is
fetched. It runs in slices of about 20 ms, one per worker task, so an extraction asked for meanwhile
waits for one slice at most. In Chromium, the first extraction of the fixture page a few seconds
after boot takes about 0.2 s instead of 3.9 s.

**Networking.** Pyodide has no sockets, and its `ssl` module is a stub, so `bootstrap.install()`
removes yt-dlp's built-in request handlers and registers `RelayRH`, a yt-dlp `RequestHandler`.

- **One request, one relay call.** Each request becomes one synchronous `XMLHttpRequest` to
  `/relay`. That is only legal inside a Worker, which is why Pyodide never runs on the main thread.
- **Redirects.** The relay returns them as data, and yt-dlp follows them itself, hop by hop, with
  its own cookie jar.
- **Body cap.** Bodies reaching Python are capped at 32 MiB. An extractor that needs bytes past the
  cap fails loudly instead of reading a silently truncated page.

**Challenges.** `SandboxJCP` subclasses yt-dlp's own `EJSBaseJCP` and overrides one hook, which runs
the solver program. yt-dlp builds the program itself from the pinned yt-dlp-ejs scripts and the
player code, and the hook POSTs it to `/solve`. At boot the engine probes `GET /solve`:

- `204`: the deployment can solve.
- `501`: it cannot. yt-dlp is then told no solver is available and uses YouTube clients that need
  none.

**Extracting.** `api.extract()` runs `extract_info(download=False)` and returns the sanitized info
dict as JSON, streaming yt-dlp's log lines to the page as it goes. The format spec prefers one file
with both streams, but falls back to the video+audio pair and then to any single stream. A site that
offers only separate streams therefore still lists its formats.

### The relay protocol

Defined once, in `src/lib/relay/protocol.ts`, and used by both ends:

| Direction | Header              | Meaning                                                                                              |
| --------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| →         | `X-Relay-Url`       | the upstream URL (a header, so the relay URL is constant and CORS preflights stay cached)            |
| →         | `X-Relay-Headers`   | upstream request headers as JSON, including ones XHR may not set (`Cookie`, `Referer`, `User-Agent`) |
| →         | `X-Relay-Max-Bytes` | the most body the relay should deliver                                                               |
| ←         | `X-Relay-Status`    | the upstream status; its absence means the relay refused, and `X-Relay-Error` says why               |
| ←         | `X-Relay-Headers`   | upstream response headers as JSON, `Set-Cookie` included                                             |
| ←         | `X-Relay-Truncated` | `1` when the body was cut at the cap                                                                 |

## Downloads and the library

When you pick a format, `downloadPlan()` takes the URL, the `http_headers` and the chunk size that
yt-dlp resolved, and hands them to the download worker. The worker:

- fetches the file through the relay in ranged chunks;
- writes each chunk with an OPFS sync access handle, which exists only in dedicated workers;
- resumes by starting from the file's current size.

While it runs, it holds a **Web Lock** named after the item:

- When a tab opens the library, any "downloading" item whose lock nobody holds was left behind by a
  closed tab, and becomes "paused".
- A second tab can never open a second writer for the same file.

A BroadcastChannel keeps every open tab's library in step. The library keeps its metadata in
IndexedDB: title, format, size, status, and the thumbnail as a Blob fetched through the relay. It
plays files from `blob:` URLs, saves them with `showSaveFilePicker()` (or a plain download), and
shows how much storage it uses: the bytes of its own items (each file as far as written, live while
it runs, and its thumbnail), counted from the library itself (`libraryBytes`). The browser's
`navigator.storage.estimate()` covers the whole origin — every app served from the same address,
such as `localhost` or a `github.io` account — so it only says how much more fits.

### Importing from the device

_Import videos…_ takes files from a file dialog. Each one is first opened the way playback will
open it, in a muted `<video>` over a `blob:` URL (`inspect.ts`): a file the browser cannot play is
refused before anything is stored. That also gives its length and size, and a still from a tenth of
the way in (at most 10 s) drawn on a canvas, which becomes its thumbnail — so an imported item needs
no relay for anything. The `<video>` is in the page, one transparent pixel in a corner of the
screen, as the frame timeline's is (`openVideo`): WebKit draws a video on a canvas only while it is
in the page and on screen, and from a detached one the thumbnail came out black. A still that is
still transparent after drawing is no thumbnail, and the library shows its placeholder instead.

The item (`origin: 'import'`, `imported.ts`) is named after the file. The download worker copies
the bytes into OPFS under the item's Web Lock, like a download: the `File` is posted to the worker
by reference and read a slice at a time (`copy.ts`), so even a large file never sits in memory.
Exported again, it is the very file that was picked, under its own name (`<title>.<ext>`, no
format tag).

An import cannot be resumed: the picked file is only lent to the page. A failed copy stays
_failed_ with its reason, and an import a closed tab interrupted becomes _failed_ when the library
next loads; both can only be deleted.

_Animate a video file…_ opens a file straight from disk in the animation maker instead. Nothing is
copied or stored, so it works without private file storage too.

### Merging

YouTube's best formats come as a video-only and an audio-only stream. `bestMergePair()` picks what
yt-dlp's `bv*+ba` would:

- the best video;
- the best audio in the same container family (MP4 or WebM);
- Matroska when the two families differ.

The library downloads both parts, one after the other, under the item's lock, then asks the
remux worker to merge them:

- **What ffmpeg does.** It runs as a single-threaded FFmpeg core, so there is no
  SharedArrayBuffer and no cross-origin isolation. It stream-copies (`-c copy`) exactly one video
  and one audio stream; MP4 also gets `+faststart`.
- **Which FFmpeg.** ffmpeg.wasm (`@ffmpeg/core`) by default. With `YT_DLP_WEB_FFMPEG=remux`, the
  remux core that `bun run build:ffmpeg` compiles from FFmpeg master: every demuxer, muxer, parser
  and bitstream filter, and no decoder, encoder or filter. Since FFmpeg 6.0 the `ffmpeg` program
  needs threads, so the remux core's entry point is `ffmpeg/remux.c`: the stream-copy subset of
  ffmpeg's command line, with ffmpeg's own stream setup and timestamp handling, on one thread.
  `ffmpeg/pre.js` gives it `@ffmpeg/core`'s JavaScript interface, and both cores use the same file
  names, so the worker and `mergeArgs()` serve either unchanged.
- **Its files.** A small Emscripten filesystem (`src/lib/remux/handle-fs.ts`) maps ffmpeg's file
  I/O onto OPFS sync access handles, so nothing is buffered in memory, whatever the video's size.
  It exposes exactly three files.
- **When it exists.** The core (~31 MiB of wasm for ffmpeg.wasm, ~2.5 MiB for the remux core) is
  fetched only for a merge: it starts loading when the merge's parts start downloading, so the
  merge finds it ready, and the worker ends when the last merge ends or its download pauses or
  fails.
- **Leaving it out.** Builds with `YT_DLP_WEB_FFMPEG=0` leave FFmpeg out. A HEAD probe tells
  the page, which then says merging is unavailable.

### Animated images

Any video in the library can become a looping animation (`src/lib/ui/AnimationDialog.svelte`).
The dialog plays the file from a `blob:` URL, like the player, and lays two controls over it:

- **A time range**: two sliders on one track (`RangeSlider.svelte`). Dragging or keying an end
  shows that frame; dragging the space between them moves the whole range; Preview loops it.
  The track is a frame timeline (`Filmstrip.svelte`, `filmstrip.ts`): pictures from across the
  whole video, as many as fill it, each the middle of the stretch under it, with the video
  outside the range darkened. A second `<video>` over the same file takes them, so the dialog's
  own is never moved. It is in the page, one transparent pixel in a corner of the screen
  (`openVideo`), because WebKit draws a video on a canvas only while it is in the page and on
  screen. Over the range, a
  mark stands where each of the animation's frames will be taken, wherever the marks are far
  enough apart to tell.
- **A crop**: a box with eight handles over the picture (`CropBox.svelte`), in the video's own
  pixels. The stage has exactly the video's shape, so the box's percentages are the picture's.

The rules both follow (clamping, minimum sizes, frame times, delays) are pure functions in
`src/lib/animate/clip.ts`, and `AnimationEditor` (`editor.svelte.ts`) holds the choices — range,
crop, format, quality, frame rate, width — and does the work:

- **Frames come from the browser's own decoder.** For each frame time the page seeks the
  `<video>`, draws the crop onto a canvas at the output size and reads the pixels back
  (`frames.ts`). Media elements exist only on the main thread, and whatever the browser can play
  it can animate, with no demuxer or decoder of the app's own and whichever FFmpeg the build
  ships, or none.
- **Seeks go to the middle of the video's pictures, never to the frame times.** A frame of an
  animation at the video's own rate, or a whole fraction of it, falls exactly where a picture
  starts, and containers round those starts: WebM and Matroska count whole milliseconds, so at
  30 fps picture 2 starts at 67 ms, after 2/30 s, and a seek to 2/30 s shows picture 1. Taken at
  the frame times, 30 fps of a 30 fps WebM came out as pictures 0, 1, 1, 3, 4, 4, … in Chromium,
  Firefox and WebKit alike. So before taking frames the page plays a moment of the range at half
  speed and notes when each picture starts (`requestVideoFrameCallback`'s `mediaTime`: every
  engine reports a picture's start while playing; after a seek, Firefox and WebKit report the time
  sought). A least-squares line through those starts is the video's frame grid (`grid.ts`),
  refined by a few more moments further on until it is good to 2 ms across the range. Each frame
  is then the grid picture on screen at its time, taken by seeking to that picture's middle, which
  no rounding can tip over. A video whose pictures keep no steady rate has no grid, and its frames
  are taken at their times.
- **The video's own rate guides the animation's.** The dialog is ready to use once the browser
  knows the video's size and length. Meanwhile the first seconds play for a moment in a `<video>`
  of their own (in the page and unseen, like the frame timeline's), which tells the video's frame
  rate (`frameRate`: 29.97 only when the measurement rules 30 out). The readout says it is being
  measured; when it is known, the animation's rate follows it, unless one was chosen meanwhile. The rates that step evenly through its pictures (`evenRates`: 15 or 10 fps of a
  30 fps video) are smooth; any other steps unevenly — 12 fps of 30 goes 2, 3, 2, 3 pictures — and
  motion judders, which the dialog says. A new animation starts at the even rate of 10 to 15 fps,
  if there is one.
- **The animate worker encodes them**, one worker per animation, gone once the file is out. When
  the dialog first opens, a worker is asked which formats this browser can make (once per page),
  and only those are offered. Each format keeps its own time from the frame rate, exactly where its unit allows:

| Format  | Encoder                                                                                                                                                                                                                                                                                                                                                          | Timing                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| GIF     | `gif.ts`, `quantize.ts`: one median-cut palette from up to 16 frames spread over the range (taken first, not taken again), ordered dithering, LZW, only the changed rectangle after frame one                                                                                                                                                                    | centiseconds, rounding carried |
| APNG    | `apng.ts`: per-row PNG filters, zlib by `CompressionStream`, only the changed rectangle (transparent where unchanged) after frame one                                                                                                                                                                                                                            | exact: delays in 1/fps         |
| JPEG XL | `jxl.ts`: lossless modular mode written by hand — YCoCg, the gradient predictor, one MA-tree leaf per channel, prefix codes, runs as LZ77 copies, 256×256 groups                                                                                                                                                                                                 | exact: ticks of 1/fps          |
| WebP    | `webp.ts`: the browser's WebP encoder (`OffscreenCanvas.convertToBlob`) makes each frame a lossy VP8 still; the app muxes them (`VP8X`, `ANIM`, `ANMF`)                                                                                                                                                                                                          | milliseconds, rounding carried |
| AVIF    | `avif.ts`, `av1.ts`, `yuv.ts`: the browser's AV1 encoder (WebCodecs `VideoEncoder`, by quantizer where it takes per-frame AV1 options, by bitrate otherwise), fed I420 the app converts (BT.709, limited range) so `colr` can say exactly how; the app writes the AVIF image sequence (`ftyp`, `meta` with the first frame as the primary image, `moov`, `mdat`) | exact: a timescale of fps      |

In every format but AVIF (where the encoder decides), a frame that changes nothing adds its time
to the one before. Frame rates stop at 30, because browsers slow GIF delays under 2 cs to
10 cs, and at most 600 frames are made at once.

The result is shown from a `blob:` URL and saved like a download; it is not kept in the library.
Where the browser cannot show the format (most cannot show JPEG XL yet), the dialog says so
instead of showing a broken image.

## Security layers

In brief (see `SECURITY.md`):

- the page's `<meta>` CSP, with no `unsafe-eval` and Trusted Types enforced;
- header CSPs for workers, and `frame-ancestors`, wherever the host can send headers. They are
  generated from `csp.config.js` into `build/_headers` and `deploy/Caddyfile`;
- the relay's allowlist, its hop-by-hop redirects and its inert responses;
- the `/solve` isolate with no network;
- integrity-pinned wheels.

## Build and assets

`bun run build` = `bun run assets` + `vite build` + `scripts/write-headers.ts`:

- `scripts/fetch-wheels.ts` downloads the pinned wheels into `.wheel-cache/`, verifying their
  SHA-256.
- `scripts/sync-assets.ts` copies the wheels, the Pyodide runtime files and an FFmpeg core with
  its license notice into `static/`: ffmpeg.wasm, the remux core with `YT_DLP_WEB_FFMPEG=remux`
  (after `bun run build:ffmpeg`), or none with `YT_DLP_WEB_FFMPEG=0`. None of these are committed.
  A build without a relay (`VITE_RELAY_URL=none`) copies none of them, and fetches no wheels.
- `scripts/write-headers.ts` writes `build/_headers` for the relay origin and base path that the
  build used.

## Testing

| Layer                                               | How                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logic, runes classes, components                    | Vitest `unit` project (jsdom)                                                                                                                                                                                                                                                                                                                                        |
| yt-dlp in real Pyodide, with the real pinned wheels | Vitest `node` project, with fixture transports standing in for the network                                                                                                                                                                                                                                                                                           |
| Merging with either FFmpeg core                     | Vitest `node` project: the real `@ffmpeg/core` and the real remux core through the real handle filesystem; the remux core on many codecs and containers, ffmpeg.wasm making and inspecting its media                                                                                                                                                                 |
| The animation encoders                              | Vitest, each format read back by a decoder that is not the app's: strict readers written from each spec (`tests/helpers/`), ffmpeg.wasm's GIF, APNG and WebP decoders and its MP4/AVIF demuxer, and jxl-oxide (WebAssembly) for JPEG XL                                                                                                                              |
| The `/solve` sandbox walls                          | real workerd, via Wrangler's test harness                                                                                                                                                                                                                                                                                                                            |
| The whole app                                       | Playwright: the built app under the deploy's headers, the **real** relay handler (`scripts/fixture-relay.ts`) with a fake video site upstream, on Chromium, Firefox and WebKit. Animations made in the browser are checked frame by frame against ffmpeg.wasm's decoding of the clip, and decoded by the browser itself (Chromium's JPEG XL decoder enabled by flag) |
| A build without a relay                             | Playwright again, on the app built with `VITE_RELAY_URL=none` (`tests/e2e/no-relay.test.ts`): it says so, ships no engine, connects nowhere else, and imports and animates videos from the device                                                                                                                                                                    |
| BrowserOS                                           | the same e2e suite, `bun run test:browseros`                                                                                                                                                                                                                                                                                                                         |
| Real YouTube                                        | `@live` tests against a deployed app, excluded by default                                                                                                                                                                                                                                                                                                            |
