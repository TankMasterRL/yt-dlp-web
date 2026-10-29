"""YouTube JS challenges, solved in a network-severed sandbox.

yt-dlp's EJS providers pipe a solver program — the lib + core scripts from the
pinned yt-dlp-ejs wheel, plus the player — to Deno/Node/QuickJS subprocesses.
Pyodide has no subprocess, so SandboxJCP keeps ALL of EJSBaseJCP (script
loading and hash checks, player download, request grouping, output parsing)
and replaces only the hook that runs the program: it is handed to an injected
solver, which POSTs it to the relay Worker's /solve endpoint. There it runs in
a worker_loader isolate with no network and no bindings.

Availability is decided once, at boot, by probing /solve (no network here:
is_available() is called often). When unavailable, yt-dlp's YouTube extractor
falls back on its own to player clients that need no challenge solving.
"""
from __future__ import annotations

from collections.abc import Callable

from yt_dlp.extractor.youtube.jsc._builtin.ejs import EJSBaseJCP
from yt_dlp.extractor.youtube.jsc.provider import (
    JsChallengeProvider,
    JsChallengeProviderError,
    JsChallengeRequest,
    register_preference,
    register_provider,
)

#: Takes the solver program (JavaScript source), returns what it printed.
Solver = Callable[[str], str]


class SolverFailure(Exception):
    """The sandbox could not run the program (unreachable, refused, or it threw)."""


_solver: Solver | None = None


def set_solver(solver: Solver | None) -> None:
    global _solver
    _solver = solver


@register_provider
class SandboxJCP(EJSBaseJCP):
    PROVIDER_NAME = 'sandbox'
    PROVIDER_VERSION = '0.1.0'
    BUG_REPORT_LOCATION = 'https://github.com/TankMasterRL/yt-dlp-web/issues'
    JS_RUNTIME_NAME = 'sandbox'

    def is_available(self) -> bool:
        return _solver is not None and self._available

    def _run_js_runtime(self, stdin: str, /) -> str:
        solver = _solver
        if solver is None:
            raise JsChallengeProviderError('the sandbox solver is not configured')
        try:
            return solver(stdin)
        except SolverFailure as e:
            raise JsChallengeProviderError(f'sandbox solver failed: {e}') from e


@register_preference(SandboxJCP)
def _preference(provider: JsChallengeProvider, requests: list[JsChallengeRequest]) -> int:
    # Higher than every built-in runtime; in Pyodide none of those is available anyway.
    return 1100
