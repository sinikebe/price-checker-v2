"""One PostgreSQL ledger bounds concurrent OFF traffic across client instances."""

import asyncio
import json
import os
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException

from app.api.v2 import auth
from app.db.v2_migrations import connect_v2, migrate_v2
from app.services import off_rate_limit as rate

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


@pytest.fixture(scope="module")
def isolated_config():
    admin_config = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    name = f"off_quota_{uuid4().hex[:10]}"

    async def create():
        admin = await connect_v2(admin_config)
        try:
            await admin.execute(f'CREATE DATABASE "{name}"')
        finally:
            await admin.close()
        config = {**admin_config, "database": name}
        await migrate_v2(config)
        return config

    config = asyncio.run(create())
    yield config

    async def drop():
        admin = await connect_v2(admin_config)
        try:
            await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        finally:
            await admin.close()

    asyncio.run(drop())


@pytest.mark.asyncio
async def test_one_hundred_callers_cannot_exceed_shared_off_budget(monkeypatch, isolated_config):
    config = isolated_config

    async def connect():
        return await connect_v2(config)

    monkeypatch.setattr(auth, "_connect", connect)
    monkeypatch.setattr(rate, "PRODUCT_MAX_WAIT_SECONDS", 0.0)
    monkeypatch.setattr(rate, "SEARCH_MAX_WAIT_SECONDS", 0.0)
    connection = await connect()
    await connection.execute("DELETE FROM v2_off_rate_events")
    await connection.close()
    outbound = 0

    async def respond(_request: httpx.Request) -> httpx.Response:
        nonlocal outbound
        outbound += 1
        return httpx.Response(200, json={"ok": True})

    clients = [httpx.AsyncClient(transport=rate.RateLimitedTransport(
        httpx.MockTransport(respond), shared_off=True
    )) for _ in range(2)]
    semaphore = asyncio.Semaphore(10)

    async def call(index: int, url: str) -> int:
        async with semaphore:
            try:
                return (await clients[index % 2].get(url)).status_code
            except rate.OffRateLimited:
                return 429

    try:
        product_url = "https://world.openfoodfacts.org/api/v2/product/3017620422003.json"
        results = await asyncio.gather(*(call(i, product_url) for i in range(100)))
        assert results.count(200) == rate.PRODUCT_LIMIT_PER_MIN == 15
        assert results.count(429) == 85
        assert outbound == 15
        search_url = "https://search.openfoodfacts.org/search?q=nutella"
        results = await asyncio.gather(*(call(i, search_url) for i in range(12)))
        assert results.count(200) == rate.SEARCH_LIMIT_PER_MIN == 10
        assert outbound == 25
        connection = await connect()
        assert await connection.fetchval("SELECT count(*) FROM v2_off_rate_events") == 25
        await connection.close()
    finally:
        for client in clients:
            await client.aclose()
        connection = await connect()
        await connection.execute("DELETE FROM v2_off_rate_events")
        await connection.close()


@pytest.mark.asyncio
async def test_off_request_fails_closed_if_shared_ledger_is_unavailable(monkeypatch):
    async def unavailable():
        raise HTTPException(status_code=503, detail="Base V2 indisponible.")

    monkeypatch.setattr(auth, "_connect", unavailable)
    outbound = 0

    async def respond(_request: httpx.Request) -> httpx.Response:
        nonlocal outbound
        outbound += 1
        return httpx.Response(200)

    async with httpx.AsyncClient(transport=rate.RateLimitedTransport(
        httpx.MockTransport(respond), shared_off=True
    )) as client:
        with pytest.raises(HTTPException) as failure:
            await client.get("https://world.openfoodfacts.org/api/v2/product/3017620422003.json")
        assert failure.value.status_code == 503
        assert outbound == 0

@pytest.mark.asyncio
async def test_queued_refresh_persists_and_updates_later(monkeypatch, isolated_config):
    from app.services import v2_off_refresh_queue as queue

    config = isolated_config

    async def connect():
        return await connect_v2(config)

    monkeypatch.setattr(queue, "_connect", connect)
    connection = await connect()
    product_id = await connection.fetchval(
        "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
        json.dumps({"name": "Queue sample", "ean": "3017620422003"}),
    )
    try:
        await queue.queue_off_refresh(connection, product_id, 0.0)
        await queue.queue_off_refresh(connection, product_id, 0.0)
        assert await connection.fetchval(
            "SELECT count(*) FROM v2_off_refresh_queue WHERE product_id=$1", product_id
        ) == 1
        await connection.execute(
            "UPDATE v2_off_refresh_queue SET next_attempt_at=now()-interval '1 second' "
            "WHERE product_id=$1", product_id,
        )

        async def fetched(_barcode: str) -> dict:
            return {"product_name": "Queue sample from OFF", "rev": 3}

        monkeypatch.setattr(queue, "fetch_full_off_product", fetched)
        assert await queue.run_due_refresh_once() == "updated"
        assert await connection.fetchval(
            "SELECT count(*) FROM v2_off_refresh_queue WHERE product_id=$1", product_id
        ) == 0
        snapshot = await connection.fetchval(
            "SELECT payload FROM v2_product_off_snapshots WHERE product_id=$1", product_id
        )
        assert json.loads(snapshot)["product_name"] == "Queue sample from OFF"
    finally:
        await connection.execute("DELETE FROM v2_products WHERE id=$1", product_id)
        await connection.close()
