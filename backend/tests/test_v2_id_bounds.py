"""An id too large for the database is a 422 on every route, not a 500 with a trace."""
import json
import os
import secrets
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from app.api.v2 import stores
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app

pytestmark = pytest.mark.skipif(not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required")


@pytest_asyncio.fixture
async def config():
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_bounds_" + secrets.token_hex(5)
    admin = await connect_v2(base)
    try:
        await admin.execute('CREATE DATABASE "' + database + '"')
    finally:
        await admin.close()
    configured = {**base, "database": database}
    try:
        await migrate_v2(configured)
        yield configured
    finally:
        admin = await connect_v2(base)
        try:
            await admin.execute('DROP DATABASE "' + database + '" WITH (FORCE)')
        finally:
            await admin.close()


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
