# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **private vulnerability reporting** for
this repository (the **Security** tab → **Report a vulnerability**), not in a public issue. Include
what an attacker controls, what they gain, and a way to reproduce it. Reports about the relay
Worker are as welcome as reports about the app.

## What runs where

| Where                   | What                       | Trust                                                                                                                    |
| ----------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Page (the app's origin) | Svelte UI                  | Runs only the app's own code: no inline scripts beyond SvelteKit's hashed bootstrap, Trusted Types enforced.             |
| Engine worker           | Pyodide + yt-dlp           | Pinned, hash-checked code that parses **untrusted** pages and JSON as data.                                              |
| Download worker         | Ranged downloads into OPFS | Moves untrusted bytes; never interprets them.                                                                            |
| Remux worker (opt-in)   | FFmpeg                     | Parses untrusted media inside WebAssembly; it can touch exactly three OPFS files. The remux core has no decoders at all. |
| Relay Worker `/relay`   | Cloudflare Worker          | A byte pipe: no secrets, no storage, no parsing.                                                                         |
| Relay Worker `/solve`   | Dynamic Worker isolate     | Runs **untrusted** YouTube player JavaScript with no network and no bindings.                                            |

Untrusted JavaScript never runs in the app's origin: YouTube's player code is evaluated only in the
`/solve` isolate.

## Content Security Policy

### The document

Every prerendered page carries its policy in a `<meta>` tag. SvelteKit hashes its own inline
bootstrap script (`kit.csp` hash mode), and the directives come from `csp.config.js`:

- `default-src 'none'`. Only what the app needs is allowed back in.
- `script-src 'self' 'wasm-unsafe-eval'` — **never `'unsafe-eval'`**. Pyodide and yt-dlp work
  without it, and e2e proves it.
- `require-trusted-types-for 'script'`, with two policies: Svelte's `svelte-trusted-html` and the
  app's `yt-dlp-web-worker-url` (same-origin http(s) script URLs only).
- `connect-src 'self' <relay origin>`. The relay origin is fixed at build time (`VITE_RELAY_URL`) and
  is the only other origin the page can reach.
- `img-src 'self' blob: data:` and `media-src 'self' blob:`. Thumbnails and media come through the
  relay and are shown from `blob:` URLs, so no third-party image or video host ever sees the viewer.
- `object-src`, `base-uri`, `form-action` and `frame-src` are all `'none'`.

The e2e suite fails on any CSP or Trusted Types violation, in the page or in a worker.

### What a `<meta>` tag cannot do — headers

A `<meta>` policy **does not apply to Web Workers**: a worker's CSP comes only from the HTTP
response that served its script. It also cannot carry `frame-ancestors`. Hosts that can send
headers send these, generated from the same `csp.config.js`:

- **Every response:**
  - a second, hash-free CSP (`frame-ancestors 'none'; base-uri 'none'; object-src 'none'`). Policies
    combine, so it only adds;
  - `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`;
  - `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin`;
  - a `Permissions-Policy` that switches off every powerful feature the app does not use;
  - `Strict-Transport-Security`.
- **Worker scripts** (`/_app/immutable/workers/*`) also get their own policy:
  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' <relay origin>;
require-trusted-types-for 'script'; trusted-types 'none'`.

  The engine, download and remux workers run under it in e2e: `vite preview` sends exactly these
  headers.

Where the rules end up:

| Host                                             | How                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| Cloudflare Pages, Workers Static Assets, Netlify | `build/_headers`, written by `bun run build`                            |
| Caddy                                            | `deploy/Caddyfile` (generated and committed; a test fails if it drifts) |
| GitHub Pages                                     | **Cannot send headers.** See below.                                     |

There is deliberately **no cross-origin isolation** (no COEP). Nothing needs SharedArrayBuffer:
Python's I/O is synchronous XHR inside a Worker, and both FFmpeg cores are single-threaded.

### On GitHub Pages

The document policy still applies, because it is in the page. The workers, however, run **without a
CSP** on GitHub Pages. In code, they are bounded as follows:

- They import only fixed same-origin URLs: Pyodide, the wheels and ffmpeg, all under the app's own
  path.
- yt-dlp's built-in request handlers are removed. Every Python request becomes one synchronous XHR
  to the relay.
- The download worker fetches only through the relay.
- The relay's allowlist bounds where any of that can go.

For the strongest setup, host the app somewhere that sends headers.

Also note that **all GitHub Pages project sites of one account share one origin**
(`https://<user>.github.io`). They can read each other's IndexedDB and OPFS data, and every one of
them counts as an allowed origin for a relay whose `ALLOWED_ORIGINS` is `https://<user>.github.io`.
Use a custom domain, or another host, when that matters.

## The relay (`/relay`)

It holds no secrets, stores nothing and parses nothing.

- **Where it will go** (the entire SSRF defence, `worker/src/policy.ts`):
  - `https` only, on the default port;
  - no credentials in the URL and no IP literals;
  - the host must be on an explicit allowlist, which defaults to the hosts YouTube extraction needs.
    Patterns are exact hosts or `*.domain`, and a wildcard too broad to be deliberate is refused;
  - **the relay never follows redirects.** It returns them as data, and yt-dlp follows them hop by
    hop, so every hop is a new relay request that passes the allowlist again.
- **Who may call it:**
  - same-origin pages, or browsers on an origin listed in `ALLOWED_ORIGINS` (exact origins only, never
    `*` or `null`);
  - the target travels in a custom header, which forces a CORS preflight;
  - navigations and document, iframe, embed and object destinations are refused, so a link or a
    frame can never turn the relay into a proxy for a page;
  - every client IP gets a request budget (Workers Rate Limiting).
- **What it forwards:**
  - `GET`, `HEAD` and `POST` (body capped at 1 MiB);
  - only the headers yt-dlp chose (tunnelled in `X-Relay-Headers`), minus hop-by-hop, routing and
    client-identity headers (`cf-*`, `x-forwarded-*`, `Forwarded`, `Via`, `X-Real-IP`, …);
  - the browser's own headers for the relay origin are never forwarded.
- **What it returns:**
  - Every response is inert if a browser ever renders it: `application/octet-stream`,
    `Content-Security-Policy: sandbox; default-src 'none'`, `nosniff`, `Content-Disposition:
attachment`, `no-store`.
  - Upstream headers, `Set-Cookie` included, travel back as JSON data, so JavaScript never reads a
    real cookie.
  - Bodies bound for Python are capped at 32 MiB and flagged when truncated.

**Deliberate limits.** Anyone allowed to call the relay can fetch anything on the allowlisted hosts
through it. It is not an anonymizer: upstream sites see Cloudflare's addresses, and the relay's
operator controls its logs. Widen `ALLOWED_HOSTS` host by host, never to a bare wildcard.

## The JavaScript sandbox (`/solve`)

YouTube's player code runs in a Worker Loader (Dynamic Worker) isolate:

- created with `globalOutbound: null`, so every `fetch()` and `connect()` throws;
- given an empty `env` and no bindings;
- limited in CPU time, with zero subrequests.

The program is its own module and is evaluated inside the isolate's fetch handler, never spliced
into the Worker's code. The same origin gate, body cap (8 MiB) and rate limit apply as for the
relay. `worker/src/solve.workerd.test.ts` checks these walls in real workerd, including an
adversarial program that tries to smuggle `fetch()` into handler context. `/solve` itself performs
no network I/O: the browser sends it the player source.

Worker Loaders need a paid Workers plan. Without one, `/solve` answers `501`, the app says so, and
yt-dlp uses YouTube clients that need no challenge solving.

## Supply chain

- **yt-dlp and yt-dlp-ejs** wheels are pinned by SHA-256 (`src/lib/engine/wheels.ts`) and verified
  at three points: when fetched, in the engine worker before they are unpacked, and in the
  integration test. yt-dlp is told never to download solver code (`remote_components: []`). Its
  solver scripts come from the pinned wheel, and yt-dlp checks their hashes itself.
- **Pyodide, ffmpeg.wasm and the npm dependencies** are locked by integrity hash in `bun.lock` and
  served from the app's own origin. No CDN, PyPI or micropip is involved at runtime.
- `bun run audit` checks the dependency tree against known advisories, and fails on anything
  moderate or worse.
- **The remux core** (`bun run build:ffmpeg`) is compiled from pinned sources, fetched by git: an
  FFmpeg commit, and an Emscripten release (emsdk's tag, or in CI that release's
  `emscripten/emsdk` image). The build is reproducible: the same pins give the same bytes.
- **ffmpeg.wasm is GPL-2.0-or-later.** Builds ship it with `ffmpeg/NOTICE.txt`, which names the tag
  of its corresponding source. `YT_DLP_WEB_FFMPEG=remux` ships the LGPL remux core instead, and
  `YT_DLP_WEB_FFMPEG=0` no FFmpeg at all. See `docs/THIRD-PARTY.md`.

## Browser storage

Downloads live in the origin's private file system (OPFS) and their metadata in IndexedDB. The
browser keeps them per origin, and anything running on that origin can read them. Clearing the
site's data deletes the library. The app asks for persistent storage only when the person asks
it to keep their downloads.
