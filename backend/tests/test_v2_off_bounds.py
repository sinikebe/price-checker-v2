"""OFF API calls must not follow redirects or buffer unbounded bodies."""

import httpx
import pytest
from app.services import openfoodfacts_client as off_client


@pytest.mark.asyncio
async def test_off_client_rejects_redirect_and_oversize(monkeypatch):
    responses = [
        httpx.Response(302, headers={"location": "https://example.org/private"}),
        httpx.Response(200, content=b'{"many":"' + b"x" * 100 + b'"}'),
    ]

    async def respond(_request):
        return responses.pop(0)

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        async def fake_client():
            return client

        monkeypatch.setattr(off_client, "get_off_client", fake_client)
        for _ in range(2):
            with pytest.raises(off_client.OffResponseError):
                await off_client.off_json_get(
                    off_client.OFF_SEARCH_URL, max_bytes=32
                )
        assert not responses


@pytest.mark.asyncio
async def test_off_client_restricts_destination_and_reads_normal_json(monkeypatch):
    async def respond(request):
        assert request.url.host == "world.openfoodfacts.org"
        return httpx.Response(200, json={"status": 1, "product": {"code": "12345678"}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        async def fake_client():
            return client

        monkeypatch.setattr(off_client, "get_off_client", fake_client)
        with pytest.raises(off_client.OffResponseError):
            await off_client.off_json_get("https://example.org/api/v2/product/12345678.json", max_bytes=1024)
        result = await off_client.off_json_get(
            "https://world.openfoodfacts.org/api/v2/product/12345678.json",
            max_bytes=1024,
        )
        assert result["product"]["code"] == "12345678"
