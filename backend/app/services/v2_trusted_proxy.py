"""Trust forwarding headers only from the current web container peer."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
import time


class TrustedWebProxyMiddleware:
    def __init__(self, app, hostname: str = "web"):
        self.app = app
        self.hostname = hostname
        self._addresses: set[str] = set()
        self._expires = 0.0

    async def _web_addresses(self) -> set[str]:
        now = time.monotonic()
        if now >= self._expires:
            try:
                answer = await asyncio.to_thread(
                    socket.getaddrinfo, self.hostname, None, 0, socket.SOCK_STREAM,
                )
                self._addresses = {item[4][0] for item in answer}
            except OSError:
                # DNS failure must not broaden the trust boundary.
                self._addresses = set()
            self._expires = time.monotonic() + 5
        return self._addresses

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        peer = scope.get("client")
        if peer and peer[0] in await self._web_addresses():
            headers: dict[bytes, list[bytes]] = {}
            for key, value in scope["headers"]:
                if key in (b"x-forwarded-for", b"x-forwarded-proto"):
                    headers.setdefault(key, []).append(value)
            forwarded = headers.get(b"x-forwarded-for", [])
            proto = headers.get(b"x-forwarded-proto", [])
            if len(forwarded) == len(proto) == 1:
                try:
                    # One host proxy, one web proxy, one client IP; no lists.
                    client_ip = str(ipaddress.ip_address(forwarded[0].decode("ascii")))
                    scheme = proto[0].decode("ascii")
                except (ValueError, UnicodeDecodeError):
                    pass
                else:
                    if scheme in ("http", "https"):
                        scope = {**scope, "client": (client_ip, 0), "scheme": scheme}
        return await self.app(scope, receive, send)
