"""An id too large for the database is a 422 on every route, not a 500 with a trace."""

import httpx
import pytest
import pytest_asyncio
from app.api.v2 import stores
from app.db.v2_migrations import connect_v2
from app.main_v2 import app
from conftest import disposable_database, requires_v2_db

pytestmark = requires_v2_db


@pytest_asyncio.fixture
async def config():
    async with disposable_database("v2_bounds_") as configured:
        yield configured


@pytest.mark.asyncio
async def test_an_oversized_id_is_refused_and_a_missing_one_is_still_not_found(config, monkeypatch):
    async def connect():
        return await connect_v2(config)
    monkeypatch.setattr(stores, "_connect", connect)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="https://test") as client:
        too_big = await client.get(f"/api/v2/stores/{2**70}")
        assert too_big.status_code == 422 and too_big.json() == {"detail": "Valeur hors limites."}
        assert "Traceback" not in too_big.text
        assert (await client.get("/api/v2/stores/999999")).status_code == 404
