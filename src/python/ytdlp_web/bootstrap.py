"""Wire yt-dlp to the browser: RelayRH for HTTP, SandboxJCP for YouTube's JS challenges.

Call ``install(transport, solver)`` before any YoutubeDL is constructed.
"""
from __future__ import annotations

from yt_dlp.networking import common

from . import relay_rh
from .transport import Transport, TransportFailure, TransportRequest, TransportResponse


def install(transport, solver=None) -> None:
    """Route yt-dlp's HTTP traffic through ``transport`` and its JS challenges to ``solver``.

    ``transport`` is a Python ``Transport`` or a JavaScript function implementing
    ``SyncTransport`` (src/lib/engine/transport.ts). ``solver`` takes a solver
    program and returns its output (Python or JavaScript); ``None`` means this
    deployment cannot solve, and yt-dlp uses YouTube clients that need no solving.
    """
    # yt-dlp's built-in handlers (urllib; requests/curl_cffi/websockets are not
    # installed) need sockets and TLS, which Pyodide does not have: its ssl
    # module is a stub that raises on the first handshake. Replace them all.
    common._REQUEST_HANDLERS.clear()
    common.register_rh(relay_rh.RelayRH)
    relay_rh.set_transport(transport if _is_python_callable(transport) else _js_adapter(transport))

    from . import solver_jcp  # importing registers SandboxJCP with yt-dlp
    if solver is None or _is_python_callable(solver):
        solver_jcp.set_solver(solver)
    else:
        solver_jcp.set_solver(_js_solver_adapter(solver))


def _is_python_callable(obj) -> bool:
    try:
        from pyodide.ffi import JsProxy
    except ImportError:  # plain CPython (no Pyodide): only Python transports exist
        return True
    return not isinstance(obj, JsProxy)


def _js_solver_adapter(js_solver):
    from pyodide.ffi import JsException

    from .solver_jcp import SolverFailure

    def solve(program: str) -> str:
        try:
            return str(js_solver(program))
        except JsException as e:
            raise SolverFailure(str(e)) from e

    return solve


def _js_adapter(js_transport) -> Transport:
    from js import Object
    from pyodide.ffi import JsException, to_js

    def transport(request: TransportRequest) -> TransportResponse:
        js_request = to_js({
            'method': request.method,
            'url': request.url,
            'headers': [[name, value] for name, value in request.headers],
            'body': request.body,
            'timeoutMs': round(request.timeout * 1000),
            'maxBytes': request.max_bytes,
        }, dict_converter=Object.fromEntries)
        try:
            result = js_transport(js_request)
        except JsException as e:
            raise TransportFailure(str(e)) from e
        return TransportResponse(
            status=int(result.status),
            headers=[(str(name), str(value)) for name, value in result.headers.to_py()],
            body=result.body.to_bytes(),
            truncated=bool(result.truncated),
        )

    return transport
