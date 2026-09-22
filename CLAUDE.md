# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

yt-dlp-web runs the **unmodified** [yt-dlp](https://github.com/yt-dlp/yt-dlp) Python package in the browser via Pyodide, inside a static SvelteKit app built with Bun. Downloads land in origin-private storage (OPFS) and are browsable in an in-app library. A Cloudflare Worker does the two things a web page is not allowed to do: relay bytes across CORS (`/relay`), and run YouTube's untrusted player JavaScript in a network-severed sandbox (`/solve`). Everything browser-specific plugs into yt-dlp's own plugin seams — `RequestHandler` for networking and `JsChallengeProvider` for YouTube's JS challenges — so yt-dlp itself is never patched.

## Toolchain

- **Bun is the package manager and script runner only** — Vitest and Playwright remain the test runners. Always `bun run test`, never `bun test` (that invokes Bun's built-in test runner, which cannot run this suite).
- Vitest has two projects (`vite.config.ts`): **`unit`** (jsdom, Svelte's browser build — components, runes classes, browser-side logic) and **`node`** (plain Node resolution — `*.integration.test.ts`, `worker/**`, root `*.test.ts`). `svelteTesting()` adds the `browser` resolve condition, which swaps in browser stubs for packages like `ws`, so anything that boots a runtime lives in `node`.
- The Pyodide integration tests (`src/lib/engine/*.integration.test.ts`) boot the **real Pyodide runtime** and install the **real pinned yt-dlp wheels**, downloaded and hash-verified into the gitignored `.wheel-cache/` by `bun run fetch:wheels`; they skip themselves if the wheels are missing. `Dockerfile.test` runs the fetch at image build, so CI always exercises them.
- `worker/src/solve.workerd.test.ts` runs the Worker in **real workerd** (Wrangler's `createTestHarness`, reading `worker/wrangler.jsonc` with its Worker Loader binding) to prove the sandbox walls hold, including an adversarial program that smuggles `fetch()` into handler context.
- `bun run dev`/`build` first run `bun run assets`: fetch the pinned wheels (a no-op when the cached copies still match their pins) and copy them plus the Pyodide runtime files from `node_modules/pyodide` into the gitignored `static/wheels/` and `static/pyodide/`.
- Playwright uses a preinstalled Chromium at `/opt/pw-browsers/chromium` (`PLAYWRIGHT_CHROMIUM_PATH` overrides). Do not run `playwright install`. Firefox and WebKit run in CI (`E2E_BROWSERS=chromium,firefox,webkit` inside the Playwright image).
- CI runs the suite inside `Dockerfile.test` (official Playwright base image, with the Bun binary copied in from `oven/bun`). **Its tag must match the `@playwright/test` version in `bun.lock`** — bump them together.
- Version ceilings that are not accidents: **TypeScript 6** (SvelteKit and svelte-check do not accept 7 yet) and **Vitest 4**.

## Architecture: the pipeline

yt-dlp runs **unmodified** in Pyodide; everything browser-specific plugs into its own plugin seams.

```
URL input → ExtractSession (runes)                     src/routes/+page.svelte, src/lib/engine/session.svelte.ts
  → engine worker: Pyodide + yt-dlp                    src/workers/engine.worker.ts, src/lib/engine/{client,runtime}.ts
      boot: pinned wheels, SHA-256 checked, unpacked   src/lib/engine/wheels.ts (pins), runtime.ts (bootEngine)
      bootstrap: yt-dlp's handlers → RelayRH           src/python/ytdlp_web/{bootstrap,relay_rh,transport}.py
      RelayRH → SyncTransport (sync XHR)               src/lib/relay/client.ts (createSyncTransport)
      extract_info(download=False) → JSON + live log   src/python/ytdlp_web/api.py
  → format table (muxed first)                         src/lib/ui/FormatTable.svelte, src/lib/formats.ts

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
- **Untrusted JavaScript never runs in the app's origin.** YouTube's player JS is evaluated only inside `/solve`'s `worker_loader` isolate, created with `globalOutbound: null` (all `fetch()`/`connect()` throw) and no bindings. `/solve` receives the player source from the browser and performs no network I/O itself.
- **yt-dlp's `JsRuntime` layer (Deno/Node/QuickJS subprocesses) is unusable** — there is no subprocess in Pyodide. `SandboxJCP` subclasses yt-dlp's own `EJSBaseJCP` and overrides exactly one hook, `_run_js_runtime(program) → stdout`, which POSTs the program to `/solve`. Everything else — solver scripts from the pinned yt-dlp-ejs wheel (hash-checked by yt-dlp), player download, output parsing — is yt-dlp's code.
- **`SandboxJCP.is_available()` must not do I/O** and must be honest: yt-dlp's YouTube extractor switches to player clients that need no challenge solving when no provider is available. The engine worker probes `GET /solve` once at boot (204 = can solve, 501 = no Worker Loader) and only then installs a solver.
- **The solver program is evaluated inside the isolate's fetch handler** (`main.js` does `await import('./program.js')`), never at startup: startup has a much shorter CPU limit than `limits.cpuMs`. The walls, verified in workerd: at module scope async I/O is refused outright; from handler context `globalOutbound: null` refuses it; `env` is empty. Keep the program in its own module — never splice it into ours.
- **Error reasons in headers go through `headerSafe()`** (`worker/src/http.ts`): workerd's error messages carry CR/LF stacks, which make `new Response()` throw and turn a meaningful 422 into a bare 500.
- **No micropip, no CDN, no PyPI at runtime.** yt-dlp has zero required dependencies, so its pinned wheels are installed with `pyodide.unpackArchive(buffer, 'wheel')` from same-origin files. Wheels and the Pyodide distribution are build artifacts — never committed.
- **Dynamic Workers (`worker_loaders`) require a paid Cloudflare Workers plan.** On the free plan, delete the `worker_loaders` block from `worker/wrangler.jsonc`: `/relay` still works, `/solve` answers 501, the UI says so, and yt-dlp uses YouTube clients that need no challenge solving (fewer formats).
- **Muxed formats first.** Merging separate video and audio streams needs ffmpeg.wasm, which is opt-in, lazily loaded and single-threaded (so cross-origin isolation is never required).

## Conventions

- **Red/green TDD**: write the failing test first, then the code that turns it green. Commits land green — the branch must stay bisectable.
- **Every I/O dependency is an injected seam** (the Python request transport, the solver transport, the worker clients, storage). Tests drive them with fakes; new integrations get a seam + a fake, not a mock of a browser API.
- **Hermetic by default.** CI never touches YouTube or a deployed Worker; tests that do are tagged `@live`, excluded from the default run, and self-skip when the network is unavailable.
- E2e determinism: Playwright starts `scripts/fixture-relay.ts` — the **real** relay handler with the fake site in `tests/fixtures/site.ts` as upstream — and builds the app with `VITE_RELAY_URL` pointing at it, so e2e exercises sync XHR, CORS preflights and the relay's policy for real. Don't stub the relay with `page.route`.
- **CSP is a test gate**: e2e fails on any CSP / Trusted Types violation (`tests/e2e/csp.ts`, plus console capture for workers). `vite preview` sends worker scripts the header CSP from `csp.config.js`, the single source of the policy.
- Tests that don't touch the DOM run under `// @vitest-environment node`: jsdom and Node typed arrays come from different realms and never compare equal.
- **Never hardcode root-relative asset URLs** — subpath deploys (`BASE_PATH` env → `kit.paths.base`) break them. Resolve `base` at the call site in browser-only code (`+page.svelte`) and hand workers absolute URLs in their `load` message; workers must not import `$app/paths`.
- Build-time env: `BASE_PATH` (subpath hosting) and `VITE_RELAY_URL` (the relay Worker's origin — also the only extra origin in CSP `connect-src`; unset means same-origin, all-in-one).

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
