# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

yt-dlp-web runs the **unmodified** [yt-dlp](https://github.com/yt-dlp/yt-dlp) Python package in the browser via Pyodide, inside a static SvelteKit app built with Bun. Downloads land in origin-private storage (OPFS) and are browsable in an in-app library. A Cloudflare Worker does the two things a web page is not allowed to do: relay bytes across CORS (`/relay`), and run YouTube's untrusted player JavaScript in a network-severed sandbox (`/solve`). Everything browser-specific plugs into yt-dlp's own plugin seams — `RequestHandler` for networking and `JsChallengeProvider` for YouTube's JS challenges — so yt-dlp itself is never patched.

## Toolchain

- **Bun is the package manager and script runner only** — Vitest and Playwright remain the test runners. Always `bun run test`, never `bun test` (that invokes Bun's built-in test runner, which cannot run this suite).
- Vitest has two projects (`vite.config.ts`): **`unit`** (jsdom, Svelte's browser build — components, runes classes, browser-side logic) and **`node`** (plain Node resolution — `*.integration.test.ts`, `worker/**`, root `*.test.ts`). `svelteTesting()` adds the `browser` resolve condition, which swaps in browser stubs for packages like `ws`, so anything that boots a runtime lives in `node`.
- The Pyodide integration tests (`src/lib/engine/*.integration.test.ts`) boot the **real Pyodide runtime** and install the **real pinned yt-dlp wheels**, downloaded and hash-verified into the gitignored `.wheel-cache/` by `bun run fetch:wheels`; they skip themselves if the wheels are missing. `Dockerfile.test` runs the fetch at image build, so CI always exercises them.
- `worker/src/solve.workerd.test.ts` runs the Worker in **real workerd** (Wrangler's `createTestHarness`, reading `worker/wrangler.jsonc` with its Worker Loader binding) to prove the sandbox walls hold, including an adversarial program that smuggles `fetch()` into handler context.
- `src/lib/remux/merge.integration.test.ts` runs the **real FFmpeg cores** the app can serve — ffmpeg.wasm (`@ffmpeg/core`) and, once built, the remux core — in Node, through the same handle filesystem the remux worker mounts over OPFS (in-memory handles here). Their ESM builds target workers only, so `tests/helpers/ffmpeg.ts` shims `self`/`location` and hands them `wasmBinary`. ffmpeg.wasm also makes the inputs no fixture has (it has encoders and lavfi) and inspects every output (ffprobe); `src/lib/remux/remux-core.integration.test.ts` uses it that way to remux many codecs between many containers with the remux core.
- `bun run build:ffmpeg` (`scripts/build-ffmpeg.ts`) compiles the **remux core**: FFmpeg master at a pinned commit, configured `--disable-everything` plus every demuxer, muxer, parser and bitstream filter and the file protocol, with the pinned Emscripten — `emcc` on PATH if it is that release, else emsdk installed into the gitignored `.ffmpeg-build/` — linked with `ffmpeg/remux.c` and `ffmpeg/pre.js` into `.ffmpeg-build/dist/ffmpeg-core.{js,wasm}` (+ `build-info.json`). It is reproducible (the same pins give the same bytes, whatever the paths) and idempotent (a stamp over the pins, flags and sources); `FFMPEG_REF` builds another FFmpeg revision. The integration tests that need the core skip without it; `Dockerfile.test` builds it in an `emscripten/emsdk` stage whose tag must equal `EMSCRIPTEN_VERSION` (a test enforces it), so CI always runs them.
- `bun run dev`/`build` first run `bun run assets`: fetch the pinned wheels (a no-op when the cached copies still match their pins) and copy them plus the Pyodide runtime files from `node_modules/pyodide` into the gitignored `static/wheels/` and `static/pyodide/`, and ffmpeg.wasm's core with its GPL notice into `static/ffmpeg/` (left out when `YT_DLP_WEB_FFMPEG=0`).
- Playwright uses a preinstalled Chromium at `/opt/pw-browsers/chromium` (`PLAYWRIGHT_CHROMIUM_PATH` overrides). Do not run `playwright install`. Firefox and WebKit run in CI (`E2E_BROWSERS=chromium,firefox,webkit` inside the Playwright image). To see them before CI does, run the image with the repo mounted: `docker run --rm --network=host --ipc=host -v "$PWD":/app -w /app -v "$(which bun)":/usr/local/bin/bun:ro -e CI=1 -e E2E_BROWSERS=chromium,firefox,webkit mcr.microsoft.com/playwright:v<version>-noble bun run test:e2e` (or `bun run test:docker` for the full CI image).
- CI runs the suite inside `Dockerfile.test` (official Playwright base image, with the Bun binary copied in from `oven/bun`). **Its tag must match the `@playwright/test` version in `bun.lock`** — bump them together. Its command is the whole gate — `format:check`, `audit` (fails on moderate+ advisories), `check`, `test`, `test:e2e` on all three browsers, then the merge journey again with `YT_DLP_WEB_FFMPEG=remux` — so `bun run test:docker` is exactly CI.
- Workflows (`.github/workflows/`, every action pinned to a full commit SHA with its tag in a comment): `ci.yml` (one `test` job: build and run `Dockerfile.test`), `pages.yml` (deploys to GitHub Pages only commits CI passed on `main`; needs the repository variable `RELAY_URL`), `check-ytdlp.yml` (weekly; fails when PyPI has a newer yt-dlp than the pins — then `bun run update:ytdlp`, which moves yt-dlp and the yt-dlp-ejs it pins together and verifies the downloads).
- BrowserOS (a Chromium fork) runs only on developers' machines: `bun run test:browseros` launches `BROWSEROS_PATH` or attaches to `BROWSEROS_CDP_URL` (a running instance's DevTools endpoint) and skips without either. Specs import `test`/`expect` from `tests/e2e/fixtures.ts`, never straight from `@playwright/test`, so the attach mode can swap the browser.
- Version ceilings that are not accidents: **TypeScript 6** (SvelteKit and svelte-check do not accept 7 yet) and **Vitest 4**.
- A version floor that is not an accident: **Playwright 1.64.1**. Under 1.61.1, Firefox sometimes never ran main-world script in a freshly loaded page: `page.evaluate` hung forever in about 3% of new contexts while locators kept working, and only a reload brought it back. That was the unexplained Firefox e2e hang. 1.64.1 (Firefox 157) showed no stall in 300 contexts. `ci.test.ts` keeps `Dockerfile.test`'s image tag equal to the version `bun.lock` resolves.

## Architecture: the pipeline

yt-dlp runs **unmodified** in Pyodide; everything browser-specific plugs into its own plugin seams.

```
URL input → ExtractSession (runes)                     src/routes/+page.svelte, src/lib/engine/session.svelte.ts
  → engine worker: Pyodide + yt-dlp                    src/workers/engine.worker.ts, src/lib/engine/{client,runtime}.ts
      boot: pinned wheels, SHA-256 checked, unpacked   src/lib/engine/wheels.ts (pins), runtime.ts (bootEngine)
      bootstrap: yt-dlp's handlers → RelayRH           src/python/ytdlp_web/{bootstrap,relay_rh,transport}.py
      RelayRH → SyncTransport (sync XHR)               src/lib/relay/client.ts (createSyncTransport)
      extract_info(download=False) → JSON + live log   src/python/ytdlp_web/api.py
  → format table (muxed first)                         src/lib/ui/FormatTable.svelte, src/lib/formats.ts (downloadPlan)
  → Library (runes): IndexedDB metadata                src/lib/storage/{library.svelte,db,instance}.ts
      download worker: ranged relayFetch → OPFS        src/workers/download.worker.ts, src/lib/download/download.ts
      one Web Lock per running item (cross-tab truth)  src/lib/download/locks.ts
      "Best quality" = yt-dlp's bv*+ba, merged here    src/lib/formats.ts (bestMergePair), Library.addMerged
      remux worker: an FFmpeg core, -c copy, OPFS I/O  src/workers/remux.worker.ts, src/lib/remux/{client,merge,handle-fs}.ts
        ffmpeg.wasm, or the remux core we compile      scripts/build-ffmpeg.ts, ffmpeg/{remux.c,pre.js}
  → library page: play / save / pause / delete         src/routes/library/+page.svelte, src/lib/ui/PlayerDialog.svelte

      YouTube JS challenges → SandboxJCP → POST /solve src/python/ytdlp_web/solver_jcp.py, src/lib/relay/client.ts (createSyncSolver)

Relay Worker (no secrets, no storage, no parsing)      worker/src/
  /relay  one browser request → one upstream request   relay.ts (handler), policy.ts (SSRF guard), config.ts (env)
  /solve  solver program → worker_loader isolate       solve.ts (handler), sandbox.ts (isolate modules)
  shared: origin gate, CORS, inert error responses     http.ts
  e2e: the same handlers, fake site upstream           scripts/fixture-relay.ts, tests/fixtures/site.ts
```

**Every I/O dependency is an injected seam** with a browser default: the Python transport (`bootstrap.install(transport)`), the relay's upstream fetch and rate limiter (`RelayDeps`), the session's engine factory (`SpawnEngine`), `XMLHttpRequest`/`fetch` in the relay clients. Tests pass fakes — see `session.svelte.test.ts` and `relay.test.ts` for the pattern.

### The relay protocol (shared seam — keep both ends in step)

Defined once in `src/lib/relay/protocol.ts`, used by the Worker and both browser clients. The upstream URL travels in `X-Relay-Url` (a header, so the relay URL is constant and CORS preflights stay cached); upstream request headers — including ones XHR may not set (Cookie, Referer, Origin, User-Agent) — travel as JSON in `X-Relay-Headers`; the response carries `X-Relay-Status` and the upstream headers as JSON, Set-Cookie included (JS can never read a real one). A response **without** `X-Relay-Status` is the relay refusing (see `X-Relay-Error`), not the upstream answering.

### The worker pattern (keep the protocols mirrored)

Every worker speaks `src/lib/workers/protocol.ts` (the LiveTranslate-WebGPU shape): `load` / work message with `id` / `progress` / `ready` / `result` / `error`. Clients match results to promises by id. **Load failures must reject the pending `load()` promise** (an `error` message with no `id`), and `terminate()` must reject calls still waiting for load. Workers are created from `?worker&url` imports passed through the `yt-dlp-web-worker-url` Trusted Types policy (`src/lib/trusted-types.ts`: same-origin http(s) only).

### Reactivity model

Svelte 5 runes classes live in `.svelte.ts` files (`ExtractSession`) exposing `$state` fields; they are unit-testable in Vitest directly. Components use `$props()`/`$derived`.

## Hard constraints (these explain non-obvious code)

- **The Worker is mandatory.** youtube.com sends no `Access-Control-Allow-Origin` for arbitrary origins, so a page cannot fetch a watch page or player JS directly. Don't try to "remove the proxy". The Worker holds no secrets, stores nothing and parses nothing.
- **Pyodide has no sockets and its `ssl` module is a stub** (an `SSLContext` builds, but every handshake fails with `TLS not supported in this environment`). `bootstrap.install()` clears `yt_dlp.networking.common._REQUEST_HANDLERS` and registers `RelayRH` before any `YoutubeDL` exists.
- **Python-side I/O is synchronous `XMLHttpRequest`, which is only legal inside a Worker** (`responseType = 'arraybuffer'` on a sync XHR throws on the main thread). Pyodide never runs on the main thread.
- **The relay never follows redirects.** A browser would follow a real 3xx itself, straight into a CORS failure, so the relay returns redirects as data and `RelayRH` follows them hop by hop with yt-dlp's own redirect rules and cookie jar. Every hop is a new relay request and passes the allowlist again. Don't "optimise" this into server-side redirect following.
- **Bodies reaching Python are capped at 32 MiB** (`X-Relay-Max-Bytes`). An extractor that needs bytes beyond the cut fails loudly (`_Body` in `relay_rh.py`) instead of reading a silently truncated page. Bulk media never goes through Python.
- **Pyodide + yt-dlp need no `unsafe-eval`** — verified in e2e: the engine worker runs under a header CSP of `script-src 'self' 'wasm-unsafe-eval'` with `require-trusted-types-for 'script'; trusted-types 'none'`. Keep it that way.
- **A `<meta>` CSP never reaches a worker, and cannot say `frame-ancestors`.** Header rules live in `csp.config.js` (`securityHeaderRules`, merged per path by `headersFor` exactly as `_headers` files merge: a repeated header is comma-joined, so a worker gets both CSPs). They are sent by `vite preview` (so e2e runs under them), written to `build/_headers` by `bun run build`, and generated into `deploy/Caddyfile` by `bun scripts/write-headers.ts --caddyfile` — never edit the Caddyfile by hand (a test fails on drift). The Caddy plan uses mutually exclusive matchers because Caddy orders `header` directives itself. No COEP: nothing needs SharedArrayBuffer.
- **Only Permissions-Policy features browsers recognise**: an unknown one is a console error, and e2e fails on it (Chromium does not know `bluetooth`).
- **The engine worker shadows `importScripts`**: Pyodide probes it with a string to detect classic workers, and WebKit reports that as a Trusted Types violation under the worker CSP before throwing. The shim throws the same TypeError without touching the sink.
- **OPFS can be missing or refused** (private windows; Playwright's Linux WebKit has no StorageManager at all). `opfsAvailable()` decides; the page then says so (`data-storage="unavailable"`) and disables downloads instead of failing mid-download.
- **Untrusted JavaScript never runs in the app's origin.** YouTube's player JS is evaluated only inside `/solve`'s `worker_loader` isolate, created with `globalOutbound: null` (all `fetch()`/`connect()` throw) and no bindings. `/solve` receives the player source from the browser and performs no network I/O itself.
- **yt-dlp's `JsRuntime` layer (Deno/Node/QuickJS subprocesses) is unusable** — there is no subprocess in Pyodide. `SandboxJCP` subclasses yt-dlp's own `EJSBaseJCP` and overrides exactly one hook, `_run_js_runtime(program) → stdout`, which POSTs the program to `/solve`. Everything else — solver scripts from the pinned yt-dlp-ejs wheel (hash-checked by yt-dlp), player download, output parsing — is yt-dlp's code.
- **`SandboxJCP.is_available()` must not do I/O** and must be honest: yt-dlp's YouTube extractor switches to player clients that need no challenge solving when no provider is available. The engine worker probes `GET /solve` once at boot (204 = can solve, 501 = no Worker Loader) and only then installs a solver.
- **The solver program is evaluated inside the isolate's fetch handler** (`main.js` does `await import('./program.js')`), never at startup: startup has a much shorter CPU limit than `limits.cpuMs`. The walls, verified in workerd: at module scope async I/O is refused outright; from handler context `globalOutbound: null` refuses it; `env` is empty. Keep the program in its own module — never splice it into ours.
- **Error reasons in headers go through `headerSafe()`** (`worker/src/http.ts`): workerd's error messages carry CR/LF stacks, which make `new Response()` throw and turn a meaningful 422 into a bare 500.
- **No micropip, no CDN, no PyPI at runtime.** yt-dlp has zero required dependencies, so its pinned wheels are installed with `pyodide.unpackArchive(buffer, 'wheel')` from same-origin files. Wheels and the Pyodide distribution are build artifacts — never committed.
- **Dynamic Workers (`worker_loaders`) require a paid Cloudflare Workers plan.** On the free plan, delete the `worker_loaders` block from `worker/wrangler.jsonc`: `/relay` still works, `/solve` answers 501, the UI says so, and yt-dlp uses YouTube clients that need no challenge solving (fewer formats).
- **Muxed formats first — and extraction never fails while formats exist.** `api.py` asks yt-dlp for `best[vcodec!=none][acodec!=none]/best/bestvideo*+bestaudio/best*`. Plain `best` needs one file holding both streams, so without the fallbacks a site offering only separate video and audio (DASH) fails with "Requested format is not available" instead of listing its formats.
- **Merging is a remux, never a re-encode**: `-c copy` of exactly `0:v:0` + `1:a:0` (mp4 gets `+faststart`), in a single-threaded FFmpeg core — ffmpeg.wasm's, or the remux core (no SharedArrayBuffer, so cross-origin isolation is never required), fetched only when a merge starts — until then the page sends one HEAD probe. ffmpeg's file I/O goes through `handle-fs.ts`, an Emscripten filesystem over OPFS sync access handles: MEMFS would hold the whole output in the worker's heap, and WORKERFS is read-only. A mount holds exactly the files it is given; creating, renaming or deleting anything is EPERM.
- **The remux worker exists only while merges run** (one per burst, terminated when idle) and holds the item's Web Lock like the download worker. The Library neither resumes nor removes an item mid-merge — ffmpeg holds its files and cannot be interrupted; merges take seconds.
- **ffmpeg.wasm is GPL-2.0-or-later.** `sync-assets` ships it with `static/ffmpeg/NOTICE.txt` naming the git tag of its corresponding source, so bumping `@ffmpeg/core` needs a `FFMPEG_SOURCE_TAGS` entry (a test enforces it). It is the default; `YT_DLP_WEB_FFMPEG=remux` ships the remux core instead (same file names, so the worker and `mergeArgs` serve either) and `YT_DLP_WEB_FFMPEG=0` neither — the page then says merging is unavailable. Workers Static Assets caps files at 25 MiB: ffmpeg.wasm's wasm is 30.7 MiB, the remux core's 2.5 MiB. Vite `define`s `import.meta.env.YT_DLP_WEB_FFMPEG` so the page names the license of the core it ships.
- **The remux core is LGPL-2.1-or-later and copies streams only.** Its configure has no decoders, encoders, filters, external libraries (so no zlib), `--enable-gpl`, `--enable-version3` or `--enable-nonfree` — tests enforce the flags — and its notice names the FFmpeg commit, the configure line and the recipe files, which make relinking possible.
- **The remux core is not the ffmpeg program**: since FFmpeg 6.0 that needs threads, threads in WebAssembly need SharedArrayBuffer, and the app is never cross-origin isolated. `ffmpeg/remux.c` runs the stream-copy subset of ffmpeg's command line over libavformat on one thread, with ffmpeg's own stream setup, timestamp fixes and defaults (best video + best audio without `-map`; metadata and chapters from the first input). `-c copy` is required, anything it cannot do fails with a reason (`Option X not found.`, `… would need an encoder`), and unlike ffmpeg a demuxing error fails the run instead of truncating the output. What ffmpeg would learn by decoding, it reads from each stream's first frame with a second demuxer before probing — ADTS AAC's sample rate and channels (muxers refuse the stream without them), VP9's pixel format (without it MP4's `vpcC` box is written empty) — and unordered channel layouts get their count's default, as a decoder would give them (FFmpeg's FLV muxer asserts on them). `ffmpeg/pre.js` mirrors `@ffmpeg/core`'s `exec`/`setLogger`/`reset`/`FS` (no `ffprobe`). Emscripten ≥ 6.0.2 reads only the `createFFmpegCore()` options listed in `-sINCOMING_MODULE_JS_API` — `wasmBinary` has to be named there for Node.
- **Bulk media never goes through Python.** yt-dlp only resolves formats; `downloadPlan()` hands the chosen format's URL, `http_headers` and `http_chunk_size` to the download worker, which fetches ranged chunks via `relayFetch` and writes them with an OPFS **sync access handle** (dedicated workers only). Resume = start from the file's current size.
- **A download's truth is its Web Lock.** The download worker holds `yt-dlp-web:download:<id>` while it runs. `Library.load()` marks `downloading` items whose lock nobody holds as `paused` (a tab closed mid-download) — never ones another tab is running — and a second tab can never open a second writer for the same file.
- **Errors keep their name across worker boundaries** (`protocol.ts` sends `name`): the Library tells a pause (`AbortError`) from a failure by it.
- **Thumbnails also come through the relay** and are stored as Blobs only if the tunnelled Content-Type is `image/*`; the page shows them from `blob:` URLs (CSP `img-src 'self' blob: data:`), so no image host sees the viewer.
- **Export names are sanitized** (`exportFileName`): no separators, reserved or control characters, leading dots or trailing dots/spaces.

## Conventions

- **Red/green TDD**: write the failing test first, then the code that turns it green. Commits land green — the branch must stay bisectable.
- **Every I/O dependency is an injected seam** (the Python request transport, the solver transport, the worker clients, storage). Tests drive them with fakes; new integrations get a seam + a fake, not a mock of a browser API.
- **Hermetic by default.** CI never touches YouTube or a deployed Worker; tests that do are tagged `@live`, excluded from the default run, and self-skip when the network is unavailable.
- E2e determinism: Playwright starts `scripts/fixture-relay.ts` — the **real** relay handler with the fake site in `tests/fixtures/site.ts` as upstream — and builds the app with `VITE_RELAY_URL` pointing at it, so e2e exercises sync XHR, CORS preflights and the relay's policy for real. Don't stub the relay with `page.route`.
- **CSP is a test gate**: e2e fails on any CSP / Trusted Types violation (`tests/e2e/csp.ts`, plus console capture for workers). `vite preview` sends the full header set from `csp.config.js`, the single source of the policy.
- E2e budgets live in `tests/e2e/app.ts`: Firefox runs Python's first-time paths several times slower than Chromium (≈27 s boot, ≈19 s first extraction on the CI image), so waits on Pyodide use `ENGINE_BOOT_MS`/`EXTRACTION_MS`, never the 5 s default. Specs that need OPFS `test.skip(!(await hasOpfs(page)), NO_OPFS)` — Playwright's Linux WebKit lacks it. Every other wait is bounded too (`actionTimeout` 30 s, `navigationTimeout` 60 s, and `probe()` in `tests/e2e/app.ts` for what Playwright leaves unbounded: `page.evaluate`, a locator's `evaluate`, `download.path()`), so a stuck step fails as itself; CI keeps a trace of every failed attempt (first ones included) and uploads `test-results/` as the `e2e-results` artifact whenever one exists, even when the job passed (each Playwright run in `Dockerfile.test` gets its own `--output`, because Playwright empties its output directory when it starts; `ci.test.ts` enforces both). A test that only passes on retry is still a failure to explain — never add retries or skips to hide one.
- Tests that don't touch the DOM run under `// @vitest-environment node`: jsdom and Node typed arrays come from different realms and never compare equal.
- Fixture media are real, playable WebM clips — VP8 video-only and Opus audio-only (`tests/fixtures/media/`, regenerate with `bun scripts/make-fixture-media.ts`) — WebM because Chromium builds without proprietary codecs cannot play H.264 (MP4 merging is proven against both real FFmpeg cores in the integration tests instead). The e2e library journey compares the exported file's SHA-256 with the fixture's.
- The split-stream fixture (`/split`) is a DASH manifest of single-file representations: yt-dlp overwrites the `vcodec` of every `<source>` inside a `<video>`, so an HTML page cannot express an audio-only stream.
- **README screenshot stays current**: after any change to how the app looks, run `bun run screenshot` (the built app on the fixture site, no internet) and commit the regenerated `docs/screenshot.png` with the change.
- **Never hardcode root-relative asset URLs** — subpath deploys (`BASE_PATH` env → `kit.paths.base`) break them. Resolve `base` at the call site in browser-only code (`+page.svelte`) and hand workers absolute URLs in their `load` message; workers must not import `$app/paths`.
- Build-time env: `BASE_PATH` (subpath hosting; `basePathFromEnv()` normalizes it for SvelteKit and the header paths), `VITE_RELAY_URL` (the relay Worker's origin — also the only extra origin in CSP `connect-src`; unset means same-origin, all-in-one) and `YT_DLP_WEB_FFMPEG` (unset: ffmpeg.wasm; `remux`: the remux core, after `bun run build:ffmpeg`; `0`: no FFmpeg). Deploy layouts: `docs/SELF-HOSTING.md`; threat model and header rationale: `docs/SECURITY.md`.

## Branching & commit conventions

- Develop on a `claude/<topic>-<suffix>` branch (e.g.
  `claude/keen-brahmagupta-18fq74`).
- Branches are **fast-forward merged** into `main`
  (`git checkout main && git merge <branch>`). This keeps the history
  linear and bisectable. If the branch is behind `main`, rebase it
  first (`git rebase main`) rather than creating a merge commit.
- **Pull requests are squash-merged.** When a PR lands via GitHub, all
  commits on the branch are squashed into a single commit on `main`.
  Write the PR title as if it were the final commit message (imperative,
  concise) and use the PR body for detail.
- Commit messages: imperative, single-line subject, optional body
  explaining _why_ (e.g. why a yt-dlp plugin seam, worker-protocol
  shape, or relay policy rule was chosen). The human submitter is
  responsible for reviewing all AI-generated code, compliance, and
  taking responsibility for the contribution. Only humans can use
  "Signed-off", and the AI tools must be reported with the
  "Assisted-by" tag, e.g. `Assisted-by: Claude:<model>` or
  `Assisted-by: Claude Code`. Don't include any references to session
  links from agentic coding tools, e.g. `https://claude.ai/code/…`.
- **Never** push directly to `main` from a working branch — always
  merge via the local `git checkout main && git merge <branch>` flow
  or open a pull request.

## Pull requests

- PRs target `tankmasterrl/yt-dlp-web` and are **squash-merged**.
  Write the PR title as the final commit message.
- **Merge only on explicit request** — never merge a PR on your own
  initiative.
- Full workflow (branch → validation gates → PR body template and its
  live test-plan checklist → squash merge → branch cleanup): the
  **`pr-workflow` skill** (`.claude/skills/pr-workflow/SKILL.md`).
