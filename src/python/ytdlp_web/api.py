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
    # Muxed (video+audio in one file) first: merging needs the opt-in ffmpeg.wasm.
    'format': 'best[vcodec!=none][acodec!=none]/best',
}

#: Options a caller may override; anything else is ignored.
_ALLOWED_OVERRIDES = frozenset({'format', 'noplaylist', 'extractor_args', 'playlist_items'})


class _CollectingLogger:
    def __init__(self):
        self.warnings: list[str] = []
        self.errors: list[str] = []

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        self.warnings.append(msg)

    def error(self, msg):
        self.errors.append(msg)


def extract(url: str, options_json: str = '{}') -> str:
    """Extract metadata and formats for ``url`` without downloading.

    Returns ``{"ok": true, "info": {...}, "warnings": [...]}`` or
    ``{"ok": false, "error": "...", "warnings": [...]}``.
    """
    overrides = {k: v for k, v in json.loads(options_json).items() if k in _ALLOWED_OVERRIDES}
    logger = _CollectingLogger()
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


def _failure(error: str, logger: _CollectingLogger) -> str:
    return json.dumps({'ok': False, 'error': error, 'warnings': logger.warnings})


def _clean(message: str) -> str:
    return message.removeprefix('ERROR: ').strip()
