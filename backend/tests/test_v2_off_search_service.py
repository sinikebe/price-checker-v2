"""Search-a-licious returns hits and brand arrays, unlike legacy OFF search."""

import httpx
import pytest

from app.api.v2 import off
from app.services.openfoodfacts_client import OFF_SEARCH_URL


@pytest.mark.asyncio
async def test_search_uses_search_a_licious_contract(monkeypatch):
    async def respond(request: httpx.Request) -> httpx.Response:
        assert str(request.url).startswith(OFF_SEARCH_URL)
        assert request.url.params["q"] == "nutella"
        assert request.url.params["fields"].startswith("code,product_name,brands")
        return httpx.Response(200, json={"hits": [
            {"code": "3017620422003", "product_name": "Nutella", "brands": ["Ferrero", "Nutella"],
             "quantity": "400 g", "nutriscore_grade": "e"},
        ]})

    off._cache.clear()
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        async def fake_client():
            return client

        monkeypatch.setattr(off, "get_off_client", fake_client)
        result = await off.search_openfoodfacts("nutella", 10)
        assert len(result.suggestions) == 1
        assert result.suggestions[0].code == "3017620422003"
        assert result.suggestions[0].brand == "Ferrero"
        assert result.suggestions[0].quantity == "400 g"
    off._cache.clear()
