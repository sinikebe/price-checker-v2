"""A caller must not choose the client-IP rate-limit key via forwarded headers."""

import socket

import httpx
import pytest
from app.services.v2_trusted_proxy import TrustedWebProxyMiddleware
from fastapi import FastAPI, Request


@pytest.mark.asyncio
async def test_only_web_peer_can_set_forwarded_client(monkeypatch):
    def resolve(host, *args):
        assert host == "web"
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("172.20.0.3", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    app = FastAPI()
    app.add_middleware(TrustedWebProxyMiddleware)

    @app.get("/peer")
    async def peer(request: Request):
        return {"host": request.client.host, "scheme": request.url.scheme}

    headers = {"X-Forwarded-For": "198.51.100.8", "X-Forwarded-Proto": "https"}
    for source, expected in [
        ("203.0.113.7", {"host": "203.0.113.7", "scheme": "http"}),
        ("172.20.0.3", {"host": "198.51.100.8", "scheme": "https"}),
    ]:
        transport = httpx.ASGITransport(app=app, client=(source, 12345))
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/peer", headers=headers)
            assert response.json() == expected
    transport = httpx.ASGITransport(app=app, client=("172.20.0.3", 12345))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(
            "/peer", headers={"X-Forwarded-For": "203.0.113.4, 198.51.100.8",
                              "X-Forwarded-Proto": "https"},
        )
        assert response.json() == {"host": "172.20.0.3", "scheme": "http"}
