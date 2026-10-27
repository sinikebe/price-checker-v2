"""A missing OFF product must not be reported as an upstream outage."""

import httpx
import pytest

from app.api.v2 import off
from app.main_v2 import app
from app.services import openfoodfacts_client
from app.services.v2_off_snapshot import OffUnavailable, fetch_full_off_product

BARCODE = "3596710534050"
PRODUCT_PATH = f"/api/v2/products/off/product/{BARCODE}"
NOT_FOUND = "Produit introuvable sur Open Food Facts."


@pytest.mark.asyncio
async def test_exact_lookup_maps_upstream_404_to_cached_not_found(monkeypatch):
    calls = 0

    async def respond(request):
        nonlocal calls
        assert request.url.path.endswith(f"/{BARCODE}.json")
        calls += 1
        return httpx.Response(404, json={"status": 0})

    off._cache.clear()
    try:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(respond)
        ) as upstream:

            async def fake_client():
                return upstream

            monkeypatch.setattr(openfoodfacts_client, "get_off_client", fake_client)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                for _ in range(2):
                    result = await client.get(PRODUCT_PATH)
                    assert result.status_code == 404
                    assert result.json()["detail"] == NOT_FOUND
        assert calls == 1
    finally:
        off._cache.clear()


@pytest.mark.asyncio
async def test_exact_lookup_keeps_upstream_failure_distinct(monkeypatch):
    async def respond(_request):
        return httpx.Response(503, json={"error": "unavailable"})

    off._cache.clear()
    try:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(respond)
        ) as upstream:

            async def fake_client():
                return upstream

            monkeypatch.setattr(openfoodfacts_client, "get_off_client", fake_client)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                result = await client.get(PRODUCT_PATH)
        assert result.status_code == 502
        assert result.json()["detail"] == "Open Food Facts est indisponible."
    finally:
        off._cache.clear()


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [404, 503])
async def test_snapshot_fetch_distinguishes_missing_from_unavailable(
    monkeypatch, status_code
):
    async def respond(request):
        assert request.url.path.endswith(f"/{BARCODE}.json")
        return httpx.Response(status_code, json={"status": 0})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as upstream:

        async def fake_client():
            return upstream

        monkeypatch.setattr(openfoodfacts_client, "get_off_client", fake_client)
        if status_code == 404:
            assert await fetch_full_off_product(BARCODE) is None
        else:
            with pytest.raises(OffUnavailable):
                await fetch_full_off_product(BARCODE)
