# Third-party software shipped with the app

A build of yt-dlp-web serves these to the browser from its own origin. Development tools (Bun,
Vite, Vitest, Playwright, Wrangler, …) are not shipped; their licenses are in `node_modules/`.

| Component                                                                                   | Version                              | License                                                                                                                                             | Served as                                                                      | Source                                                                               |
| ------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp)                                                  | pinned in `src/lib/engine/wheels.ts` | Unlicense                                                                                                                                           | `wheels/yt_dlp-*.whl`, run in Pyodide                                          | [GitHub](https://github.com/yt-dlp/yt-dlp)                                           |
| [yt-dlp-ejs](https://github.com/yt-dlp/ejs)                                                 | pinned in `src/lib/engine/wheels.ts` | Unlicense AND MIT AND ISC — bundles [meriyah](https://github.com/meriyah/meriyah) (ISC) and [astring](https://github.com/davidbonnet/astring) (MIT) | `wheels/yt_dlp_ejs-*.whl`; its solver scripts run only in the `/solve` isolate | [GitHub](https://github.com/yt-dlp/ejs)                                              |
| [Pyodide](https://pyodide.org)                                                              | `pyodide` in `bun.lock`              | MPL-2.0; the CPython inside it is under the PSF License, and its bundled libraries under their own licenses                                         | `pyodide/`                                                                     | [GitHub](https://github.com/pyodide/pyodide)                                         |
| [ffmpeg.wasm core](https://github.com/ffmpegwasm/ffmpeg.wasm) (`@ffmpeg/core`), **opt-out** | `@ffmpeg/core` in `bun.lock`         | **GPL-2.0-or-later**: FFmpeg built with GPL components, such as x264                                                                                | `ffmpeg/`, next to `ffmpeg/NOTICE.txt`                                         | the git tag named in `NOTICE.txt` (`FFMPEG_SOURCE_TAGS` in `scripts/sync-assets.ts`) |
| [Svelte](https://svelte.dev), [SvelteKit](https://svelte.dev/docs/kit)                      | `bun.lock`                           | MIT                                                                                                                                                 | compiled into `_app/`                                                          | [GitHub](https://github.com/sveltejs)                                                |

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

To ship **no** GPL code, build with `YT_DLP_WEB_FFMPEG=0`. The core is then left out, and the page
says merging is unavailable. This is also required for Cloudflare Workers Static Assets, which caps
files at 25 MiB (the core's wasm is ~31 MiB).
