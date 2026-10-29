"""A yt-dlp RequestHandler that sends every request through an injected transport.

Pyodide has no sockets and its ``ssl`` module is a stub, so none of yt-dlp's
built-in handlers can work in a browser. ``RelayRH`` hands each request to a
synchronous transport (sync XHR to the relay Worker in the browser, fixtures in
tests) that performs exactly one upstream request. Redirects come back as 3xx
responses and are followed here, hop by hop, with yt-dlp's own redirect rules
and cookie jar — so every hop is re-checked by the relay's allowlist, and
cookies are scoped to the host they belong to.
"""
from __future__ import annotations

import io
import urllib.parse
import urllib.request

from yt_dlp.networking._helper import get_redirect_method
from yt_dlp.networking.common import RequestHandler, Response
from yt_dlp.networking.exceptions import HTTPError, RequestError, TransportError
from yt_dlp.utils.networking import HTTPHeaderDict, normalize_url

from .transport import Transport, TransportFailure, TransportRequest, TransportResponse

MAX_REDIRECTS = 10
#: Pages, API JSON and player scripts fit comfortably; bulk media never goes through Python.
MAX_BODY_BYTES = 32 * 1024 * 1024
_REDIRECT_STATUSES = (301, 302, 303, 307, 308)

_transport: Transport | None = None


def set_transport(transport: Transport | None) -> None:
    global _transport
    _transport = transport


class _Body(io.BytesIO):
    """Response body that fails loudly if a reader needs bytes the transport cut off."""

    def __init__(self, data: bytes, truncated: bool):
        super().__init__(data)
        self._truncated = truncated
        self._size = len(data)

    def read(self, size: int | None = -1) -> bytes:
        chunk = super().read(size)
        wanted_more = size is None or size < 0 or len(chunk) < size
        if self._truncated and wanted_more and self.tell() >= self._size:
            raise TransportError(
                f'response body exceeds {MAX_BODY_BYTES} bytes, too large to process in the browser')
        return chunk


class _CookieSource:
    """The minimal response shape http.cookiejar.CookieJar.extract_cookies() reads."""

    def __init__(self, response: Response):
        self._headers = response.headers

    def info(self):
        return self._headers


class RelayRH(RequestHandler):
    RH_NAME = 'relay'
    _SUPPORTED_URL_SCHEMES = ('http', 'https')
    # Proxies are meaningless here: every request already goes through the relay.
    _SUPPORTED_PROXY_SCHEMES = ()
    _SUPPORTED_FEATURES = ()

    def _check_extensions(self, extensions):
        super()._check_extensions(extensions)
        extensions.pop('cookiejar', None)
        extensions.pop('timeout', None)
        # TLS terminates at the relay, so legacy-SSL tweaks cannot apply.
        extensions.pop('legacy_ssl', None)
        extensions.pop('keep_header_casing', None)

    def _send(self, request):
        transport = _transport
        if transport is None:
            raise RequestError('No relay transport is configured')

        cookiejar = self._get_cookiejar(request)
        timeout = self._calculate_timeout(request)
        method = request.method
        url = request.url
        body = _read_body(request.data)
        headers = HTTPHeaderDict(self._get_headers(request))

        for hop in range(MAX_REDIRECTS + 1):
            # Cookie is recomputed from the jar on every hop, so a cookie never
            # follows a redirect to a host it was not set for.
            headers.pop('Cookie', None)
            if cookie := cookiejar.get_cookie_header(url):
                headers['Cookie'] = cookie

            try:
                result = transport(TransportRequest(
                    method=method, url=url, headers=list(headers.items()), body=body,
                    timeout=timeout, max_bytes=MAX_BODY_BYTES))
            except TransportFailure as e:
                raise TransportError(cause=e) from e

            response = _to_response(result, url)
            cookiejar.extract_cookies(_CookieSource(response), urllib.request.Request(url))

            location = response.get_header('Location')
            if result.status in _REDIRECT_STATUSES and location:
                if hop == MAX_REDIRECTS:
                    raise HTTPError(response, redirect_loop=True)
                new_method = get_redirect_method(method, result.status)
                if new_method != method:
                    body = None
                    headers.pop('Content-Length', None)
                    headers.pop('Content-Type', None)
                method = new_method
                url = normalize_url(urllib.parse.urljoin(url, location))
                continue

            if not 200 <= result.status < 300:
                raise HTTPError(response)
            return response

        raise AssertionError('unreachable')  # pragma: no cover


def _read_body(data) -> bytes | None:
    if data is None:
        return None
    if isinstance(data, (bytes, bytearray)):
        return bytes(data)
    if hasattr(data, 'read'):
        return data.read()
    return b''.join(data)


def _to_response(result: TransportResponse, url: str) -> Response:
    response = Response(_Body(result.body, result.truncated), url, {}, status=result.status)
    for name, value in result.headers:
        response.headers.add_header(name, value)
    return response
