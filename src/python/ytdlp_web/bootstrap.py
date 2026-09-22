"""Wire yt-dlp to the browser: swap its request handlers for RelayRH.

Call ``install(js_transport)`` once, before any YoutubeDL is constructed.
"""
from __future__ import annotations

from yt_dlp.networking import common

from . import relay_rh
from .transport import Transport, TransportFailure, TransportRequest, TransportResponse


def install(transport) -> None:
    """Route all of yt-dlp's HTTP traffic through ``transport``.

    ``transport`` is either a Python ``Transport`` or a JavaScript function
    implementing the ``SyncTransport`` contract (src/lib/engine/transport.ts).
    """
    # yt-dlp's built-in handlers (urllib; requests/curl_cffi/websockets are not
    # installed) need sockets and TLS, which Pyodide does not have: its ssl
    # module is a stub that raises on the first handshake. Replace them all.
    common._REQUEST_HANDLERS.clear()
    common.register_rh(relay_rh.RelayRH)
    relay_rh.set_transport(transport if _is_python_callable(transport) else _js_adapter(transport))


def _is_python_callable(obj) -> bool:
    try:
        from pyodide.ffi import JsProxy
    except ImportError:  # plain CPython (no Pyodide): only Python transports exist
        return True
    return not isinstance(obj, JsProxy)


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
