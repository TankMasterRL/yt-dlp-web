# yt-dlp-web

Run [yt-dlp](https://github.com/yt-dlp/yt-dlp) in your browser. The real yt-dlp Python package runs
client-side in [Pyodide](https://pyodide.org); downloads are stored in your browser's origin-private
file system and listed in a local library. A small Cloudflare Worker relays bytes across CORS and
solves YouTube's JavaScript challenges in a network-severed sandbox.

Work in progress — see [`CLAUDE.md`](CLAUDE.md) for the design constraints.
