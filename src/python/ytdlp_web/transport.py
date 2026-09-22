"""The synchronous transport seam: one upstream HTTP request per call.

Kept free of Pyodide imports so the handler logic reads as plain Python; the
adapter that calls into JavaScript lives in ``bootstrap``. See
src/lib/engine/transport.ts for the JavaScript side of the contract.
"""
from __future__ import annotations

import dataclasses
from collections.abc import Callable


@dataclasses.dataclass(frozen=True)
class TransportRequest:
    method: str
    url: str
    headers: list[tuple[str, str]]
    body: bytes | None
    timeout: float
    max_bytes: int | None


@dataclasses.dataclass(frozen=True)
class TransportResponse:
    status: int
    #: Upstream headers; repeated names (Set-Cookie) appear once per value.
    headers: list[tuple[str, str]]
    body: bytes
    #: The upstream body was longer than ``max_bytes`` and was cut off.
    truncated: bool = False


class TransportFailure(Exception):
    """The request never produced an upstream response (relay unreachable, refused, timed out)."""


Transport = Callable[[TransportRequest], TransportResponse]
