# Third-party software shipped with the app

A build of yt-dlp-web serves these to the browser from its own origin. Development tools (Bun,
Vite, Vitest, Playwright, Wrangler, …) are not shipped; their licenses are in `node_modules/`.

| Component                                                                                               | Version                                 | License                                                                                                                                             | Served as                                                                      | Source                                                                                  |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp)                                                              | pinned in `src/lib/engine/wheels.ts`    | Unlicense                                                                                                                                           | `wheels/yt_dlp-*.whl`, run in Pyodide                                          | [GitHub](https://github.com/yt-dlp/yt-dlp)                                              |
| [yt-dlp-ejs](https://github.com/yt-dlp/ejs)                                                             | pinned in `src/lib/engine/wheels.ts`    | Unlicense AND MIT AND ISC — bundles [meriyah](https://github.com/meriyah/meriyah) (ISC) and [astring](https://github.com/davidbonnet/astring) (MIT) | `wheels/yt_dlp_ejs-*.whl`; its solver scripts run only in the `/solve` isolate | [GitHub](https://github.com/yt-dlp/ejs)                                                 |
| [Pyodide](https://pyodide.org)                                                                          | `pyodide` in `bun.lock`                 | MPL-2.0; the CPython inside it is under the PSF License, and its bundled libraries under their own licenses                                         | `pyodide/`                                                                     | [GitHub](https://github.com/pyodide/pyodide)                                            |
| [ffmpeg.wasm core](https://github.com/ffmpegwasm/ffmpeg.wasm) (`@ffmpeg/core`), **opt-out**             | `@ffmpeg/core` in `bun.lock`            | **GPL-2.0-or-later**: FFmpeg built with GPL components, such as x264                                                                                | `ffmpeg/`, next to `ffmpeg/NOTICE.txt`                                         | the git tag named in `NOTICE.txt` (`FFMPEG_SOURCE_TAGS` in `scripts/sync-assets.ts`)    |
| [FFmpeg](https://ffmpeg.org)'s libraries as the remux core, **instead**, with `YT_DLP_WEB_FFMPEG=remux` | the commit in `scripts/build-ffmpeg.ts` | **LGPL-2.1-or-later**: FFmpeg built without GPL, version 3 or nonfree components. Emscripten's runtime and C library: MIT and NCSA                  | `ffmpeg/`, next to `ffmpeg/NOTICE.txt`                                         | the FFmpeg commit and configure line named in `NOTICE.txt`; the rest is this repository |
| [Svelte](https://svelte.dev), [SvelteKit](https://svelte.dev/docs/kit)                                  | `bun.lock`                              | MIT                                                                                                                                                 | compiled into `_app/`                                                          | [GitHub](https://github.com/sveltejs)                                                   |

## ffmpeg.wasm and the GPL

The app loads ffmpeg.wasm only to merge separately downloaded video and audio streams, and only
when someone asks it to. It ships as separate, unmodified files, and runs in its own worker.

Anyone who distributes a build that includes it takes on the GPL's obligations for those files. The
app keeps them easy to meet:

- `ffmpeg/NOTICE.txt` names the license and the exact git tag of the corresponding source. The tag
  holds ffmpeg.wasm's build recipe, which pins FFmpeg and every library compiled into the core.
- The download page links that notice wherever merging is offered.
- `bun scripts/sync-assets.ts` refuses to copy a core whose source tag it does not know. A test
  fails too, so an `@ffmpeg/core` upgrade has to record where its source is.

To ship **no** GPL code, build with `YT_DLP_WEB_FFMPEG=remux` (the remux core, below) or
`YT_DLP_WEB_FFMPEG=0`: then no FFmpeg is shipped, and the page says merging is unavailable. One of
the two is also required for Cloudflare Workers Static Assets, which caps files at 25 MiB (ffmpeg.wasm's
wasm is ~31 MiB, the remux core's ~2.5 MiB).

## The remux core and the LGPL

`bun run build:ffmpeg` compiles FFmpeg's libraries, unmodified, and links them with this
repository's `ffmpeg/remux.c` and `ffmpeg/pre.js` into one WebAssembly file. Built without GPL,
version 3 or nonfree components, and with no external library, FFmpeg is LGPL-2.1-or-later; tests
fail if its configure flags change that.

Anyone who distributes a build that includes the remux core takes on the LGPL's obligations for it:

- `ffmpeg/NOTICE.txt` names the license, the exact FFmpeg commit and configure line, and the files
  of this repository that make up the rest of the core. With those, anyone can rebuild it, against
  a modified FFmpeg too: `bun run build:ffmpeg` takes any FFmpeg revision (`FFMPEG_REF`).
- The download page names the license of whichever core the build ships, next to the link to its
  notice.
