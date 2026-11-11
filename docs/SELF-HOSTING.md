# Self-hosting

yt-dlp-web has two parts:

1. **the app**: a static site (`bun run build` → `build/`);
2. **the relay Worker** (`worker/`): `/relay` carries bytes across CORS, and `/solve` runs YouTube's
   player JavaScript in a sandbox.

Fetching from sites needs the relay: youtube.com does not let pages on other origins read it. The
relay is optional, though. Built without one (`VITE_RELAY_URL=none`), the app is a private library
for videos imported from the device — played, saved and made into animated images in the browser
— and fetches nothing from anywhere.

Pick a layout:

| Layout                                | App                                 | Relay                                  | Security headers                         | Merging (FFmpeg)                       |
| ------------------------------------- | ----------------------------------- | -------------------------------------- | ---------------------------------------- | -------------------------------------- |
| **Static host with headers + Worker** | Cloudflare Pages, Netlify, Caddy, … | its own `workers.dev` or custom domain | ✓ (`build/_headers`, `deploy/Caddyfile`) | ✓                                      |
| **All-in-one Worker**                 | the Worker's static assets          | same origin                            | ✓ (`build/_headers`)                     | the remux core only (25 MiB asset cap) |
| **GitHub Pages + Worker**             | GitHub Pages                        | its own domain                         | ✗ (the page's `<meta>` CSP only)         | ✓                                      |
| **Any static host, no Worker**        | any of the above                    | none: nothing is fetched               | as the host allows                       | — (nothing is downloaded to merge)     |

`docs/SECURITY.md` explains what the headers add and what GitHub Pages gives up.

## 1. The relay Worker

Skip this for a build without a relay (section 2, `VITE_RELAY_URL=none`).

You need a Cloudflare account, then `bunx wrangler login` once.

1. In `worker/wrangler.jsonc`, set `ALLOWED_ORIGINS` to the origin(s) the app will be served from.
   These are exact origins, comma-separated, e.g. `https://ytdlp.example.org`. Same-origin callers are
   always admitted, so the all-in-one layout can leave it empty.
2. `/solve` needs **Worker Loaders**, which require a **paid** Workers plan. On the free plan,
   delete the `worker_loaders` block. `/relay` still works and `/solve` answers `501`. The app says
   so, and yt-dlp uses YouTube clients that need no JavaScript challenges, which means fewer
   formats.
3. `bun run worker:deploy`. Note the URL it prints, e.g. `https://yt-dlp-web.<account>.workers.dev`.

Optional variables (`vars` in `wrangler.jsonc`, or the dashboard):

| Variable                 | Default         | Meaning                                                                                                                |
| ------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ALLOWED_HOSTS`          | YouTube's hosts | Comma-separated host patterns the relay may fetch (`a.com, *.b.com`). Widen it host by host, never to a bare wildcard. |
| `MAX_REQUEST_BODY_BYTES` | 1 MiB           | Largest request body relayed upstream.                                                                                 |
| `MAX_BUFFERED_BYTES`     | 32 MiB          | Largest response body handed to Python.                                                                                |
| `SOLVE_CPU_MS`           | 10000           | CPU budget of one `/solve` isolate.                                                                                    |
| `MAX_PROGRAM_BYTES`      | 8 MiB           | Largest solver program accepted.                                                                                       |

The `RATE_LIMITER` binding gives each client IP 600 requests a minute. One extraction takes about
5–10 requests, and a 1 GB download in 10 MB chunks about 100.

## 2. Building the app

```bash
bun install
VITE_RELAY_URL=https://yt-dlp-web.<account>.workers.dev bun run build
```

| Variable                  | Meaning                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_RELAY_URL`          | The relay's URL. Its origin becomes the only extra origin in the CSP's `connect-src`. Leave it unset when the relay shares the app's origin (all-in-one). |
| `VITE_RELAY_URL=none`     | No relay at all. The download page says the site fetches nothing; no engine starts, and Pyodide, the wheels and FFmpeg are left out of `build/`.          |
| `BASE_PATH`               | Serve from a subpath, e.g. `/yt-dlp-web`. The paths in `build/_headers` follow it.                                                                        |
| `YT_DLP_WEB_FFMPEG=remux` | Ship the remux core `bun run build:ffmpeg` compiled instead of ffmpeg.wasm: ~2.5 MiB instead of ~31 MiB, LGPL instead of GPL. Run the command first.      |
| `YT_DLP_WEB_FFMPEG=0`     | Leave FFmpeg out: no merging of separate video and audio, and no GPL code shipped.                                                                        |

`build/` is the whole site. `build/_headers` holds its security headers for hosts that read that
file.

Without a relay:

```bash
VITE_RELAY_URL=none bun run build
```

The CSP's `connect-src` is then just `'self'`. No PyPI download is needed either: the wheels are
neither fetched nor shipped. Upload `build/` to any of the hosts below. The library imports, plays,
saves and animates the videos people already have, and nothing they import leaves their browser.
Building again with a relay's URL later adds the download page; the library keeps what was
imported (it lives in each visitor's browser, under the site's origin).

## 3. Hosting it

### Cloudflare Pages or Netlify

Upload `build/`, for example with `bunx wrangler pages deploy build`. Both read `build/_headers`.

### Caddy

`deploy/Caddyfile` serves `build/` with the same headers. It is generated from `csp.config.js`, so
edit that and run `bun scripts/write-headers.ts --caddyfile` rather than editing the Caddyfile. From
the repository root:

```bash
VITE_RELAY_URL=https://yt-dlp-web.<account>.workers.dev bun run build
SITE_ADDRESS=ytdlp.example.org RELAY_ORIGIN=https://yt-dlp-web.<account>.workers.dev \
  caddy run --config deploy/Caddyfile
```

Build without `BASE_PATH` here, since this serves the app from the site root. `RELAY_ORIGIN` must be
the origin of the `VITE_RELAY_URL` you built with. `SITE_ROOT` overrides where `build/` is.

### GitHub Pages

`.github/workflows/pages.yml` deploys every commit on `main` that CI passed:

1. **Settings → Pages → Source: GitHub Actions.**
2. To fetch from sites: **Settings → Secrets and variables → Actions → Variables:** add
   `RELAY_URL`, your relay's URL.
3. In `worker/wrangler.jsonc`, `ALLOWED_ORIGINS` must include `https://<owner>.github.io` (a custom
   domain's origin instead, if you use one). Then redeploy the Worker.

The workflow builds with the base path GitHub Pages reports (`/<repository>`, or none on a custom
domain) and `VITE_RELAY_URL=$RELAY_URL`. Without `RELAY_URL` it builds without a relay
(`VITE_RELAY_URL=none`) and says so in a notice on the run: the site then imports and animates
videos from the device only. Set `RELAY_URL` later and the next deploy has the download page.

GitHub Pages cannot send headers, and all project sites of an account share one origin: see
`docs/SECURITY.md`.

### All-in-one: the Worker serves the app too

The app, `/relay` and `/solve` then share one origin. The CSP's `connect-src` is just `'self'`,
there is no CORS, and `build/_headers` applies to every page.

```bash
bun run build:ffmpeg                    # the remux core, once
YT_DLP_WEB_FFMPEG=remux bun run build   # no VITE_RELAY_URL: the relay is same-origin
```

Uncomment the `assets` block in `worker/wrangler.jsonc`, then run `bun run worker:deploy`.
`run_worker_first` routes `/relay` and `/solve` to the Worker; everything else is a static asset,
and unknown paths get the app's `404.html`.

ffmpeg.wasm cannot come along: Workers Static Assets caps a file at 25 MiB and its wasm is
30.7 MiB, so Wrangler refuses the upload. The remux core's wasm is 2.5 MiB. Build with
`YT_DLP_WEB_FFMPEG=0` instead to ship no FFmpeg at all; the page then says merging is unavailable.

## Checking a deployment

- Open the app. The status line should read _yt-dlp … ready_. If `/solve` cannot solve, a note
  says so. If the relay does not answer at all — the Worker is switched off or not deployed, or its
  `ALLOWED_ORIGINS` leaves out the app's origin — a note says _The relay at … isn't answering this
  page_; the library still imports and animates videos from the device. A build without a relay
  says _This site has no relay_ instead, and starts no engine.
- `curl -I https://<app>/` should show `content-security-policy: frame-ancestors 'none'…`.
  `curl -I https://<app>/_app/immutable/workers/<engine worker>.js` should show the worker's own
  policy. On GitHub Pages neither appears.
- Fetch a video's formats and download one. It lands in **Library**, plays there, and can be saved.
- In **Library**, _Import videos…_ a file from your device. It plays, saves back unchanged, and
  _Animate_ makes a GIF of it.
