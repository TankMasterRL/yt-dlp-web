# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

yt-dlp-web runs the **unmodified** [yt-dlp](https://github.com/yt-dlp/yt-dlp) Python package in the browser via Pyodide, inside a static SvelteKit app built with Bun. Downloads land in origin-private storage (OPFS) and are browsable in an in-app library. A Cloudflare Worker does the two things a web page is not allowed to do: relay bytes across CORS (`/relay`), and run YouTube's untrusted player JavaScript in a network-severed sandbox (`/solve`). Everything browser-specific plugs into yt-dlp's own plugin seams — `RequestHandler` for networking and `JsChallengeProvider` for YouTube's JS challenges — so yt-dlp itself is never patched.

## Hard constraints (these explain non-obvious code)

- **The Worker is mandatory.** youtube.com sends no `Access-Control-Allow-Origin` for arbitrary origins, so a page cannot fetch a watch page or player JS directly. Don't try to "remove the proxy". The Worker holds no secrets, stores nothing and parses nothing.
- **Pyodide's `ssl` module is a stub** (importable; real TLS raises `NotImplementedError`). yt-dlp's built-in request handlers must be removed from `yt_dlp.networking.common._REQUEST_HANDLERS` before a `YoutubeDL` is constructed, otherwise the urllib handler raises while building an `SSLContext`.
- **Python-side I/O is synchronous `XMLHttpRequest`, which is only legal inside a Worker** (`responseType = 'arraybuffer'` on a sync XHR throws on the main thread). Pyodide never runs on the main thread.
- **Untrusted JavaScript never runs in the app's origin.** YouTube's player JS is evaluated only inside `/solve`'s `worker_loader` isolate, created with `globalOutbound: null` (all `fetch()`/`connect()` throw) and no bindings. `/solve` receives the player source from the browser and performs no network I/O itself.
- **yt-dlp's `JsRuntime` layer (Deno/Node/QuickJS subprocesses) is unusable** — there is no subprocess in Pyodide. The JS-challenge provider reuses the marshalling of `yt_dlp/extractor/youtube/jsc/_builtin/ejs.py` and only swaps the transport (subprocess → HTTP `/solve`).
- **No micropip, no CDN, no PyPI at runtime.** yt-dlp has zero required dependencies, so its pinned wheels are installed with `pyodide.unpackArchive(buffer, 'wheel')` from same-origin files. Wheels and the Pyodide distribution are build artifacts — never committed.
- **Dynamic Workers (`worker_loader`) require a paid Cloudflare Workers plan.** On the free plan `/relay` works but `/solve` does not, and YouTube formats that need an n/sig challenge solved will be missing.
- **Muxed formats first.** Merging separate video and audio streams needs ffmpeg.wasm, which is opt-in, lazily loaded and single-threaded (so cross-origin isolation is never required).

## Conventions

- **Red/green TDD**: write the failing test first, then the code that turns it green. Commits land green — the branch must stay bisectable.
- **Every I/O dependency is an injected seam** (the Python request transport, the solver transport, the worker clients, storage). Tests drive them with fakes; new integrations get a seam + a fake, not a mock of a browser API.
- **Hermetic by default.** CI never touches YouTube or a deployed Worker; tests that do are tagged `@live`, excluded from the default run, and self-skip when the network is unavailable.

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
