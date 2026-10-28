"""Catalogue grouping/search and conservative Open Prices import contracts."""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from app.api.v2 import catalogue
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app
from app.services import v2_open_prices_sync as sync


def _config():
    return json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())


def _price(code: str, *, price_id=41001, currency="EUR", country="FR",
           discounted=False, duplicate_of=None) -> dict:
    return {
        "id": price_id, "type": "PRODUCT", "product_code": code,
        "price": 2.49, "currency": currency, "price_is_discounted": discounted,
        "date": (datetime.now(sync.PARIS).date() - timedelta(days=1)).isoformat(),
        "duplicate_of": duplicate_of,
        "location": {
            "id": 44001, "type": "OSM", "osm_type": "NODE", "osm_id": 990001,
            "osm_name": "Test Épicerie", "osm_brand": "Test Marché",
            "osm_address_city": "Paris", "osm_address_postcode": "75001",
            "osm_address_country_code": country,
        },
    }


def test_open_prices_validation_and_backoff():
    valid = _price("3017620422003")
    assert sync._valid_price(valid, "3017620422003") is not None
    for changed in (
        {**valid, "currency": "USD"},
        {**valid, "price_is_discounted": True},
        {**valid, "duplicate_of": 1},
        {**valid, "location": {**valid["location"], "osm_address_country_code": "BE"}},
        {**valid, "date": (datetime.now(sync.PARIS).date() + timedelta(days=1)).isoformat()},
    ):
        assert sync._valid_price(changed, "3017620422003") is None
    assert sync._retry_seconds("10") == 6 * 3600
    assert sync._retry_seconds("864000") == 24 * 3600


@pytest.mark.skipif(not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable PostgreSQL required")
@pytest.mark.asyncio
async def test_catalogue_groups_and_store_filter(monkeypatch):
    config = _config()
    await migrate_v2(config)
    connection = await connect_v2(config)
    group = "Test biscuits " + uuid4().hex[:8]
    ids = []
    retailer = store = None
    try:
        for index in range(2):
            ids.append(await connection.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
                json.dumps({"brand": "Test", "name": "Biscuit " + str(index),
                            "group": group, "ean": "3017620422003"}),
            ))
        retailer = await connection.fetchval(
            "INSERT INTO v2_retailers(code,name) VALUES($1,'Test Retailer') RETURNING id",
            "test-" + uuid4().hex[:20],
        )
        store = await connection.fetchval(
            "INSERT INTO v2_stores(retailer_id,name,city) VALUES($1,'Test Store','Paris') RETURNING id",
            retailer,
        )
        await connection.execute(
            "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,"
            "source,price,observed_at) VALUES($1,$2,$3,'manual',2.49,now())",
            ids[0], retailer, store,
        )
        async def fake_connect():
            return await connect_v2(config)
        monkeypatch.setattr(catalogue, "_connect", fake_connect)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="https://test") as client:
            categories = (await client.get("/api/v2/catalogue/categories")).json()
            assert next(item for item in categories if item["name"] == group)["product_count"] == 2
            detail = await client.get("/api/v2/catalogue/categories/" + group)
            assert detail.status_code == 200, detail.text
            assert {item["id"] for item in detail.json()["products"]} == set(ids)
            assert len(detail.json()["observations"]) == 1
            matches = (await client.get("/api/v2/catalogue/search",
                                        params={"category": group, "store_id": store})).json()
            assert matches["total"] == 1
            assert matches["items"][0]["id"] == ids[0]
            assert (await client.get("/api/v2/catalogue/search",
                                     params={"category": group, "limit": 1, "offset": 1})).json()["total"] == 2
            stores = (await client.get("/api/v2/catalogue/stores", params={"q": "Test Store"})).json()
            assert any(item["id"] == store for item in stores)
    finally:
        await connection.execute("DELETE FROM v2_price_observations WHERE product_id=ANY($1::bigint[])", ids)
        if store:
            await connection.execute("DELETE FROM v2_stores WHERE id=$1", store)
        if retailer:
            await connection.execute("DELETE FROM v2_retailers WHERE id=$1", retailer)
        await connection.execute("DELETE FROM v2_products WHERE id=ANY($1::bigint[])", ids)
        await connection.close()


@pytest.mark.skipif(not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable PostgreSQL required")
@pytest.mark.asyncio
async def test_open_prices_cycle_deduplicates_and_respects_shared_slot(monkeypatch):
    config = _config()
    await migrate_v2(config)
    connection = await connect_v2(config)
    product_id = None
    code = "3017620422003"
    try:
        product_id = await connection.fetchval(
            "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
            json.dumps({"name": "Test sync", "group": "Test", "ean": code}),
        )
        await connection.execute(
            "UPDATE v2_open_prices_sync_control SET next_run_at=now()-interval '1 minute'"
        )
        async def fake_connect():
            return await connect_v2(config)
        monkeypatch.setattr(sync, "_connect", fake_connect)
        monkeypatch.setattr(sync, "_read_config", lambda: config)
        monkeypatch.setattr(sync, "get_settings", lambda: SimpleNamespace(APP_ENV="dev"))
        calls = []
        def respond(request):
            calls.append(request)
            return httpx.Response(200, json={"items": [
                _price(code), _price(code, price_id=41002, currency="USD"),
                _price(code, price_id=41003, country="BE"),
                _price(code, price_id=41004, discounted=True),
            ]})
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            first = await sync.run_sync_cycle(client)
            assert first == {"status": "ok", "requested": 1, "imported": 1}
            assert len(calls) == 1
            assert calls[0].url.host == "prices.openfoodfacts.net"
            assert (await sync.run_sync_cycle(client))["status"] == "not_due"
            await connection.execute(
                "UPDATE v2_open_prices_sync_control SET next_run_at=now()-interval '1 minute'"
            )
            assert (await sync.run_sync_cycle(client))["requested"] == 0
            assert len(calls) == 1
        row = await connection.fetchrow(
            "SELECT source,source_provider,source_record_id FROM v2_price_observations "
            "WHERE product_id=$1", product_id,
        )
        assert dict(row) == {"source": "third_party", "source_provider": "open_prices",
                             "source_record_id": "41001"}
    finally:
        if product_id:
            await connection.execute("DELETE FROM v2_price_observations WHERE product_id=$1", product_id)
            await connection.execute("DELETE FROM v2_open_prices_sync_state WHERE product_id=$1", product_id)
            await connection.execute("DELETE FROM v2_products WHERE id=$1", product_id)
        await connection.execute("DELETE FROM v2_stores WHERE import_key='open_prices:location:44001'")
        await connection.execute("DELETE FROM v2_retailers WHERE name='Test Marché'")
        await connection.close()


@pytest.mark.skipif(not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable PostgreSQL required")
@pytest.mark.asyncio
async def test_open_prices_429_stops_cycle_and_postpones(monkeypatch):
    config = _config()
    await migrate_v2(config)
    connection = await connect_v2(config)
    product_id = None
    try:
        product_id = await connection.fetchval(
            "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
            json.dumps({"name": "Test throttled sync", "ean": "3017620422003"}),
        )
        await connection.execute(
            "UPDATE v2_open_prices_sync_control SET next_run_at=now()-interval '1 minute'"
        )
        async def fake_connect():
            return await connect_v2(config)
        monkeypatch.setattr(sync, "_connect", fake_connect)
        monkeypatch.setattr(sync, "_read_config", lambda: config)
        monkeypatch.setattr(sync, "get_settings", lambda: SimpleNamespace(APP_ENV="dev"))
        async with httpx.AsyncClient(transport=httpx.MockTransport(
            lambda _: httpx.Response(429, headers={"Retry-After": "1800"})
        )) as client:
            outcome = await sync.run_sync_cycle(client)
        assert outcome == {"status": "rate_limited", "requested": 1, "imported": 0}
        assert await connection.fetchval(
            "SELECT next_run_at > now()+interval '5 hours' FROM v2_open_prices_sync_control"
        )
        assert await connection.fetchval(
            "SELECT count(*) FROM v2_open_prices_sync_state WHERE product_id=$1", product_id
        ) == 0
    finally:
        if product_id:
            await connection.execute("DELETE FROM v2_products WHERE id=$1", product_id)
        await connection.close()
