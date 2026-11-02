"""The browser extension's plan and readings: administrators in a browser session only, bounded, EAN-checked."""

from __future__ import annotations

import json
import os
import secrets
from decimal import Decimal
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from app.api.v2 import extension
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app
from fastapi import HTTPException

pytestmark = pytest.mark.skipif(not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required")
WRITE = {"origin": "https://test"}
ADMIN = {**WRITE, "x-test-role": "admin"}
PAGE = "https://www.carrefour.fr/p/pates-spaghetti-carrefour-3560070328888"


@pytest_asyncio.fixture
async def config():
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_ext_" + secrets.token_hex(5)
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


@pytest_asyncio.fixture
async def db(config):
    connection = await connect_v2(config)
    try:
        yield connection
    finally:
        await connection.close()


@pytest.fixture
def served(monkeypatch, config):
    async def connect():
        return await connect_v2(config)

    async def current_user(_connection, request):
        role = request.headers.get("x-test-role")
        return {"id": 1, "username": "someone", "role": role} if role else None
    monkeypatch.setattr(extension, "_connect", connect)
    monkeypatch.setattr(extension, "_current_user", current_user)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="https://test")


async def seed(db):
    """A Carrefour store with prices, a second chain's store, and four products."""
    carrefour = await db.fetchval("INSERT INTO v2_retailers(code,name) VALUES('carrefour','Carrefour') RETURNING id")
    other = await db.fetchval("INSERT INTO v2_retailers(code,name) VALUES('auchan','Auchan') RETURNING id")
    store = await db.fetchval("INSERT INTO v2_stores(retailer_id,name,city,postal_code) VALUES($1,'Carrefour City Maisons-Laffitte','Maisons-Laffitte','78600') RETURNING id", carrefour)
    foreign = await db.fetchval("INSERT INTO v2_stores(retailer_id,name,city,postal_code) VALUES($1,'Auchan Houilles','Houilles','78800') RETURNING id", other)
    products = []
    for ean, name in (("3560070328888", "Pâtes spaghetti"), ("7613039830727", "Fond de veau"), ("3270190008262", "Huile d'olive"), ("3256225148370", "Lait de coco")):
        products.append(await db.fetchval("INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id", json.dumps({"ean": ean, "brand": "Test", "name": name})))
    # Something already priced at the store, so that it is the chain's store to read for.
    await db.execute("INSERT INTO v2_price_observations(product_id,retailer_id,store_id,source,price,observed_at,sales_channel) "
                     "VALUES($1,$2,$3,'manual',1.00,now() - interval '40 days','drive')", products[0], carrefour, store)
    return carrefour, other, store, foreign, products


@pytest.mark.asyncio
async def test_only_an_administrator_in_a_browser_session_may_use_it(db, served):
    _c, _o, store, _f, products = await seed(db)
    plan = {"adapter": "carrefour", "product_ids": products}
    reading = {"adapter": "carrefour", "store_id": store, "product_id": products[1], "ean": "7613039830727", "outcome": "price", "price": 3.6}
    async with served as client:
        for headers in ({}, WRITE, {**WRITE, "x-test-role": "confirmed"}, {**ADMIN, "authorization": "Bearer pcv2_x"}):
            assert (await client.post("/api/v2/extension/plan", headers=headers, json=plan)).status_code == 403, headers
            assert (await client.post("/api/v2/extension/readings", headers=headers, json=reading)).status_code == 403, headers
        assert (await client.post("/api/v2/extension/plan", headers={**ADMIN, "origin": "https://evil.example"}, json=plan)).status_code == 403
        assert (await client.post("/api/v2/extension/plan", headers=ADMIN, json=plan)).status_code == 200


@pytest.mark.asyncio
async def test_the_plan_lists_what_needs_reading_in_basket_order_and_the_store_to_read_for(db, served):
    carrefour, _o, store, foreign, products = await seed(db)
    fresh, held, no_ean = products[1], products[2], await db.fetchval("INSERT INTO v2_products(data) VALUES('{\"name\":\"x\"}') RETURNING id")
    await db.execute("INSERT INTO v2_price_observations(product_id,retailer_id,store_id,source,price,observed_at,sales_channel) "
                     "VALUES($1,$2,$3,'manual',3.6,now() - interval '1 day','drive')", fresh, carrefour, store)
    await db.execute("SELECT v2_mark_store_product_discontinued($1,$2,'drive')", held, store)
    async with served as client:
        asked = [products[3], no_ean, held, fresh, products[0], 999999]
        answer = (await client.post("/api/v2/extension/plan", headers=ADMIN, json={"adapter": "carrefour", "product_ids": asked})).json()
        assert answer["store"] == {"id": store, "name": "Carrefour City Maisons-Laffitte", "city": "Maisons-Laffitte", "postal_code": "78600", "retailer": "Carrefour"}
        assert [item["product_id"] for item in answer["items"]] == [products[3], products[0]], "basket order; fresh, held, EAN-less and unknown ones are left out"
        assert answer["items"][0] == {"product_id": products[3], "ean": "3256225148370", "brand": "Test", "name": "Lait de coco"}
        # Two stores of the chain with prices: not guessed.
        second = await db.fetchval("INSERT INTO v2_stores(retailer_id,name,city,postal_code) VALUES($1,'Carrefour Market','Sartrouville','78500') RETURNING id", carrefour)
        await db.execute("INSERT INTO v2_price_observations(product_id,retailer_id,store_id,source,price,observed_at,sales_channel) "
                         "VALUES($1,$2,$3,'manual',2,now() - interval '40 days','drive')", products[3], carrefour, second)
        unclear = (await client.post("/api/v2/extension/plan", headers=ADMIN, json={"adapter": "carrefour", "product_ids": asked})).json()
        assert unclear == {"store": None, "items": [], "reason": "store_ambiguous"}
        # The stores the person chose as defaults settle it; other chains' stores in the list change nothing.
        chosen = (await client.post("/api/v2/extension/plan", headers=ADMIN, json={"adapter": "carrefour", "product_ids": asked, "store_ids": [second, foreign]})).json()
        assert chosen["store"]["id"] == second and chosen["reason"] is None
        both = (await client.post("/api/v2/extension/plan", headers=ADMIN, json={"adapter": "carrefour", "product_ids": asked, "store_ids": [store, second]})).json()
        assert both == {"store": None, "items": [], "reason": "store_ambiguous"}
        only_foreign = (await client.post("/api/v2/extension/plan", headers=ADMIN, json={"adapter": "carrefour", "product_ids": asked, "store_ids": [foreign]})).json()
        assert only_foreign["reason"] == "store_ambiguous", "no default of the chain: back to the stores with captured prices"
        for bad in ({"adapter": "carrefour", "product_ids": [1], "store_ids": [0]}, {"adapter": "carrefour", "product_ids": [1], "store_ids": list(range(1, 52))},
                    {"adapter": "carrefour", "product_ids": []}, {"adapter": "carrefour", "product_ids": [0]}, {"adapter": "carrefour", "product_ids": [2**63]},
                    {"adapter": "carrefour", "product_ids": list(range(1, extension.MAX_PLAN_PRODUCTS + 2))}, {"adapter": "leclerc", "product_ids": [1]}):
            assert (await client.post("/api/v2/extension/plan", headers=ADMIN, json=bad)).status_code == 422, bad
    assert foreign  # the other chain's store never becomes the target


@pytest.mark.asyncio
async def test_the_plan_is_capped(db, served):
    _c, _o, _s, _f, products = await seed(db)
    ids = [await db.fetchval("INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id", json.dumps({"ean": f"123456789{n:04d}"[:13], "name": f"p{n}"})) for n in range(80)]
    async with served as client:
        answer = (await client.post("/api/v2/extension/plan", headers=ADMIN, json={"adapter": "carrefour", "product_ids": ids})).json()
        assert len(answer["items"]) == extension.MAX_PLAN_ITEMS
    assert products


@pytest.mark.asyncio
async def test_a_price_is_recorded_like_a_connectors_and_clears_the_withdrawn_status(db, served):
    carrefour, _o, store, _f, products = await seed(db)
    product = products[1]
    await db.execute("SELECT v2_mark_store_product_discontinued($1,$2,'drive')", product, store)
    body = {"adapter": "carrefour", "store_id": store, "product_id": product, "ean": "07613039830727", "outcome": "price", "price": 2.89,
            "available": True, "source_url": PAGE, "title": "  Fond de Veau   MAGGI "}
    async with served as client:
        answer = await client.post("/api/v2/extension/readings", headers=ADMIN, json=body)
        assert answer.status_code == 201 and answer.json() == {"saved": True, "reason": None}
        row = await db.fetchrow("SELECT price,source,source_provider,sales_channel,available,source_url,capture_ean FROM v2_price_observations WHERE product_id=$1 AND source='connector'", product)
        assert (row["price"], row["source"], row["source_provider"], row["sales_channel"], row["available"], row["source_url"], row["capture_ean"]) == (
            Decimal("2.89"), "connector", "carrefour", "drive", True, PAGE, "07613039830727")
        assert await db.fetchval("SELECT title FROM v2_offers WHERE source_provider='carrefour'") == "Fond de Veau MAGGI"
        assert await db.fetchval("SELECT count(*) FROM v2_store_product_status") == 0
        assert await db.fetchval("SELECT count(*) FROM v2_logs WHERE connector='carrefour' AND event='connector.reading.finished'") == 1
        again = await client.post("/api/v2/extension/readings", headers=ADMIN, json=body)
        assert again.json() == {"saved": False, "reason": "fresh"}, "a second reading while the price is fresh is not stored"
        assert await db.fetchval("SELECT count(*) FROM v2_price_observations WHERE product_id=$1 AND source='connector'", product) == 1


@pytest.mark.asyncio
async def test_a_product_not_sold_is_withdrawn_at_that_store_only(db, served):
    _c, _o, store, _f, products = await seed(db)
    other = await db.fetchval("INSERT INTO v2_stores(retailer_id,name,city) SELECT retailer_id,'Carrefour Hyper','Poissy' FROM v2_stores WHERE id=$1 RETURNING id", store)
    async with served as client:
        answer = await client.post("/api/v2/extension/readings", headers=ADMIN, json={"adapter": "carrefour", "store_id": store, "product_id": products[2], "ean": "3270190008262", "outcome": "not_sold"})
        assert answer.status_code == 201 and answer.json() == {"saved": False, "reason": "not_sold"}
        assert await db.fetchval("SELECT v2_store_product_held($1,$2,'drive')", products[2], store) is True
        assert await db.fetchval("SELECT v2_store_product_held($1,$2,'drive')", products[2], other) is False
        assert await db.fetchval("SELECT count(*) FROM v2_price_observations WHERE product_id=$1", products[2]) == 0


@pytest.mark.asyncio
async def test_a_reading_that_does_not_fit_is_refused(db, served):
    _c, _o, store, foreign, products = await seed(db)
    good = {"adapter": "carrefour", "store_id": store, "product_id": products[1], "ean": "7613039830727", "outcome": "price", "price": 3.6}
    async with served as client:
        cases = [
            ({"store_id": foreign}, 422, "another chain's store"),
            ({"store_id": 999999}, 422, "unknown store"),
            ({"ean": "3270190008262"}, 422, "the barcode is not the product's"),
            ({"product_id": 999999}, 422, "unknown product"),
            ({"price": None}, 422, "a price reading needs a price"),
            ({"outcome": "not_sold"}, 422, "a not-sold reading carries no price"),
            ({"price": 0}, 422, "zero"), ({"price": -1}, 422, "negative"), ({"price": 10000}, 422, "too high"), ({"price": 1.234}, 422, "three decimals"),
            ({"ean": "abc"}, 422, "bad barcode"), ({"adapter": "leclerc"}, 422, "unknown site"),
            ({"source_url": "https://evil.example/p/x"}, 422, "another host"), ({"source_url": "https://www.carrefour.fr/p/a b"}, 422, "whitespace"),
            ({"source_url": "http://www.carrefour.fr/p/x"}, 422, "not https"),
        ]
        for change, status, why in cases:
            assert (await client.post("/api/v2/extension/readings", headers=ADMIN, json={**good, **change})).status_code == status, why
        assert await db.fetchval("SELECT count(*) FROM v2_price_observations WHERE source='connector'") == 0
        assert await db.fetchval("SELECT count(*) FROM v2_store_product_status") == 0


@pytest.mark.asyncio
async def test_readings_are_limited_per_hour(db, served, monkeypatch):
    _c, _o, store, _f, products = await seed(db)
    monkeypatch.setattr(extension, "READINGS_PER_HOUR", 2)
    async with served as client:
        for n, expected in enumerate((201, 201, 429)):
            body = {"adapter": "carrefour", "store_id": store, "product_id": products[2], "ean": "3270190008262", "outcome": "not_sold"}
            assert (await client.post("/api/v2/extension/readings", headers=ADMIN, json=body)).status_code == expected, n


def test_the_guard_refuses_a_token_even_for_an_administrator():
    async def run():
        class Request:
            headers = {"authorization": "Bearer pcv2_x"}

        async def admin(_connection, _request):
            return {"id": 1, "role": "admin"}
        original = extension._current_user
        extension._current_user = admin
        try:
            with pytest.raises(HTTPException) as refused:
                await extension._admin(None, Request())
            assert refused.value.status_code == 403
        finally:
            extension._current_user = original
    import asyncio
    asyncio.run(run())


@pytest.mark.asyncio
async def test_stores_that_only_open_prices_knows_are_not_candidates(db, served):
    carrefour, _o, store, _f, products = await seed(db)
    for number in range(5):  # Carrefour stores all over the country, known only through Open Prices
        far = await db.fetchval("INSERT INTO v2_stores(retailer_id,name,city) VALUES($1,$2,'Ailleurs') RETURNING id", carrefour, f"Carrefour {number}")
        await db.execute("INSERT INTO v2_price_observations(product_id,retailer_id,store_id,source,source_provider,price,observed_at,sales_channel) "
                         "VALUES($1,$2,$3,'third_party','open_prices',2,now(),'in_store')", products[1], carrefour, far)
    async with served as client:
        answer = (await client.post("/api/v2/extension/plan", headers=ADMIN, json={"adapter": "carrefour", "product_ids": products})).json()
        assert answer["store"]["id"] == store and answer["reason"] is None
        # Nothing captured at all: no store to read for.
        await db.execute("DELETE FROM v2_price_observations WHERE source='manual'")
        none = (await client.post("/api/v2/extension/plan", headers=ADMIN, json={"adapter": "carrefour", "product_ids": products})).json()
        assert none == {"store": None, "items": [], "reason": "store_unknown"}
