"""The surface the engine worker calls. Inputs and outputs are JSON strings."""
from __future__ import annotations

import json

import yt_dlp
from yt_dlp.utils import YoutubeDLError

#: Parameters every extraction runs with; callers may add but not remove safety.
BASE_PARAMS = {
    'quiet': True,
    'noprogress': True,
    'noplaylist': True,
    # There is no subprocess in Pyodide, so no Deno/Node/QuickJS: YouTube's JS
    # challenges go through the sandboxed solver provider instead.
    'js_runtimes': {},
    # Never fetch solver code from the network — it ships inside the pinned
    # (integrity-checked) yt-dlp-ejs wheel.
    'remote_components': [],
    # Muxed first (one file with both streams; merging needs the opt-in
    # ffmpeg.wasm): known codecs, then any single file yt-dlp calls complete.
    # Then the pair a merge would take, then any single stream. Plain `best`
    # needs a file with both streams, so without the fallbacks a site offering
    # only separate video and audio (DASH) fails with "Requested format is not
    # available" instead of listing its formats.
    'format': 'best[vcodec!=none][acodec!=none]/best/bestvideo*+bestaudio/best*',
}

#: Options a caller may override; anything else is ignored.
_ALLOWED_OVERRIDES = frozenset({'format', 'noplaylist', 'extractor_args', 'playlist_items'})


class _Logger:
    """Collects warnings and streams yt-dlp's screen output to ``on_log(level, line)``."""

    def __init__(self, on_log=None):
        self.warnings: list[str] = []
        self._on_log = on_log

    def _emit(self, level: str, msg: str) -> None:
        if self._on_log is not None:
            self._on_log(level, msg)

    def debug(self, msg):
        # With a logger set, yt-dlp sends both its screen output and its
        # "[debug] " lines here; only the former is meant for people.
        if not msg.startswith('[debug] '):
            self._emit('info', msg)

    def info(self, msg):
        self._emit('info', msg)

    def warning(self, msg):
        self.warnings.append(msg)
        self._emit('warning', msg)

    def error(self, msg):
        self._emit('error', msg)


def extract(url: str, options_json: str = '{}', on_log=None) -> str:
    """Extract metadata and formats for ``url`` without downloading.

    ``on_log(level, line)`` receives yt-dlp's progress lines as they happen.
    Returns ``{"ok": true, "info": {...}, "warnings": [...]}`` or
    ``{"ok": false, "error": "...", "warnings": [...]}``.
    """
    overrides = {k: v for k, v in json.loads(options_json).items() if k in _ALLOWED_OVERRIDES}
    logger = _Logger(on_log)
    params = {**BASE_PARAMS, **overrides, 'logger': logger}
    try:
        with yt_dlp.YoutubeDL(params) as ydl:
            info = ydl.sanitize_info(ydl.extract_info(url, download=False))
    # Not just DownloadError: some extractors read response bodies outside
    # yt-dlp's error wrapping, so network errors (RequestError) can surface raw.
    # The CLI catches these at its top level; this is our top level.
    except YoutubeDLError as e:
        return _failure(_clean(str(e)), logger)
    except Exception as e:  # never hand the UI an unhandled Python exception
        return _failure(f'Internal error ({type(e).__name__}): {e}', logger)
    return json.dumps({'ok': True, 'info': info, 'warnings': logger.warnings})


def _failure(error: str, logger: _Logger) -> str:
    return json.dumps({'ok': False, 'error': error, 'warnings': logger.warnings})


def _clean(message: str) -> str:
    return message.removeprefix('ERROR: ').strip()
