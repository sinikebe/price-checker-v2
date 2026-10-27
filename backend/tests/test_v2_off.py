"""V2 OFF lookup is independent and never writes a product."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

from app.api.v2 import products
from app.main_v2 import app
from app.schemas.openfoodfacts import (
    OpenFoodFactsSearchResponse,
    OpenFoodFactsSuggestion,
)


@pytest.mark.asyncio
async def test_v2_off_search_and_exact_lookup(monkeypatch):
    suggestion = OpenFoodFactsSuggestion(
        code="8711200548002",
        product_name="Mayonnaise de Dijon",
        brand="Amora",
        quantity="415 g",
        ingredients_text="Huile, oeufs",
        nutriscore_grade="c",
        nova_group=4,
        nutriscore_version="2023",
    )
    search = AsyncMock(
        return_value=OpenFoodFactsSearchResponse(suggestions=[suggestion])
    )
    exact = AsyncMock(return_value=suggestion)
    monkeypatch.setattr(products, "search_openfoodfacts", search)
    monkeypatch.setattr(products, "get_openfoodfacts_product", exact)

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        result = await client.get("/api/v2/products/off/search?q=mayonnaise")
        assert result.status_code == 200
        assert result.json()["suggestions"][0]["ingredients_text"] == "Huile, oeufs"
        search.assert_awaited_once_with(q="mayonnaise", page_size=10)

        result = await client.get("/api/v2/products/off/product/8711200548002")
        assert result.status_code == 200
        assert result.json()["nutriscore_grade"] == "c"
        exact.assert_awaited_once_with("8711200548002")

        assert (await client.get("/api/v2/products/off/search?q=a")).status_code == 422
        exact.side_effect = HTTPException(status_code=404, detail="Not found")
        assert (
            await client.get("/api/v2/products/off/product/8711200548002")
        ).status_code == 404
        exact.side_effect = HTTPException(status_code=429, detail="Try later")
        assert (
            await client.get("/api/v2/products/off/product/8711200548002")
        ).status_code == 429
