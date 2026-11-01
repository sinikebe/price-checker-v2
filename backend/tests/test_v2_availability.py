"""A product withdrawn at one store: held there only, re-checked after a delay, never hidden elsewhere."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from app.api.v2 import availability, basket, prices
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app
from fastapi import HTTPException

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)
WRITE = {"origin": "https://test"}


@pytest_asyncio.fixture
async def config():
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_avail_" + secrets.token_hex(5)
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

    async def session_user(_connection, request):
        if not request.headers.get("x-test-user"):
            raise HTTPException(status_code=401, detail="Connectez-vous.")
        return {"id": int(request.headers["x-test-user"]), "username": "someone",
                "role": request.headers.get("x-test-role", "confirmed")}

    for module in (availability, basket, prices):
        monkeypatch.setattr(module, "_connect", connect)
    monkeypatch.setattr(availability, "_current_user", current_user)
    monkeypatch.setattr(basket, "_session_user", session_user)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="https://test")


async def seed(db):
    """One product sold at two stores (one of them a drive), with a price at each."""
    retailer = await db.fetchval("INSERT INTO v2_retailers(code,name) VALUES('t','Test') RETURNING id")
    stores = [await db.fetchval(
        "INSERT INTO v2_stores(retailer_id,name,city,postal_code) VALUES($1,$2,'Paris','75001') RETURNING id",
        retailer, name) for name in ("Nord", "Sud")]
    product = await db.fetchval(
        "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
        json.dumps({"brand": "Test", "name": "Lait", "group": "Lait", "quantity": "1 L"}))
    for number, store in enumerate(stores):
        await db.execute(
            "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,source,price,observed_at,sales_channel) "
            "VALUES($1,$2,$3,'manual',$4,now() - interval '400 days','drive')", product, retailer, store, 1 + number)
    return retailer, stores, product


async def held(db, product, store, channel="drive") -> bool:
    return await db.fetchval("SELECT v2_store_product_held($1,$2,$3)", product, store, channel)


async def mark(db, product, store, channel="drive"):
    await db.execute("SELECT v2_mark_store_product_discontinued($1,$2,$3)", product, store, channel)


async def age(db, product, store, days):
    await db.execute(
        "UPDATE v2_store_product_status SET checked_at=now() - make_interval(days => $3), "
        "since=now() - make_interval(days => $3) WHERE product_id=$1 AND store_id=$2", product, store, days)


@pytest.mark.asyncio
async def test_a_withdrawn_product_is_held_at_that_store_only_until_the_recheck_delay(db):
    _retailer, (nord, sud), product = await seed(db)
    assert not await held(db, product, nord)
    await mark(db, product, nord)
    assert await held(db, product, nord)
    assert not await held(db, product, sud), "another store is untouched"
    assert not await held(db, product, nord, "in_store"), "another sales channel is untouched"
    await age(db, product, nord, 29)
    assert await held(db, product, nord)
    await age(db, product, nord, 31)
    assert not await held(db, product, nord), "the default delay is thirty days"
    await db.execute("UPDATE v2_availability_settings SET recheck_days=60")
    assert await held(db, product, nord), "the delay is the administrators' setting"
    await db.execute("UPDATE v2_availability_settings SET recheck_days=0")
    await age(db, product, nord, 300)
    assert await held(db, product, nord), "zero means never by itself"


@pytest.mark.asyncio
async def test_marking_again_keeps_the_first_date_but_a_newer_price_starts_a_new_withdrawal(db):
    retailer, (nord, _sud), product = await seed(db)
    await mark(db, product, nord)
    await age(db, product, nord, 31)
    first = await db.fetchval("SELECT since FROM v2_store_product_status WHERE product_id=$1", product)
    await mark(db, product, nord)  # looked again, still withdrawn
    row = await db.fetchrow("SELECT since,checked_at FROM v2_store_product_status WHERE product_id=$1", product)
    assert row["since"] == first and row["checked_at"] > first
    assert await held(db, product, nord)
    await age(db, product, nord, 10)
    await db.execute(
        "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,source,price,observed_at,sales_channel) "
        "VALUES($1,$2,$3,'manual',1.20,now() - interval '1 day','drive')", product, retailer, nord)
    assert not await held(db, product, nord), "a price seen after the check lifts the status"
    await mark(db, product, nord)
    new = await db.fetchrow("SELECT since,checked_at FROM v2_store_product_status WHERE product_id=$1", product)
    assert new["since"] > first, "it came back, then went again: the withdrawal is a new one"


@pytest.mark.asyncio
async def test_clearing_forgets_the_status_and_deleting_a_product_or_store_removes_its_rows(db):
    _retailer, (nord, sud), product = await seed(db)
    await mark(db, product, nord)
    await mark(db, product, sud)
    await db.execute("SELECT v2_clear_store_product_status($1,$2,'drive')", product, nord)
    assert not await held(db, product, nord) and await held(db, product, sud)
    await db.execute("DELETE FROM v2_price_observations WHERE store_id=$1", sud)
    await db.execute("DELETE FROM v2_stores WHERE id=$1", sud)
    assert await db.fetchval("SELECT count(*) FROM v2_store_product_status") == 0


@pytest.mark.asyncio
async def test_only_a_known_status_and_channel_can_be_stored(db):
    _retailer, (nord, _sud), product = await seed(db)
    for status, channel in (("gone", "drive"), ("discontinued", "teleport")):
        with pytest.raises(Exception, match="check"):
            await db.execute(
                "INSERT INTO v2_store_product_status(product_id,store_id,sales_channel,status) VALUES($1,$2,$3,$4)",
                product, nord, channel, status)


@pytest.mark.asyncio
async def test_the_recheck_delay_is_an_administrator_setting_with_bounds_and_a_revision(db, served):
    async with served as client:
        admin = {**WRITE, "x-test-role": "admin"}
        assert (await client.get("/api/v2/availability/settings")).status_code == 403
        assert (await client.get("/api/v2/availability/settings", headers={"x-test-role": "confirmed"})).status_code == 403
        current = await client.get("/api/v2/availability/settings", headers=admin)
        assert current.json() == {"recheck_days": 30, "revision": 0, "min": 0, "max": 365}
        assert current.headers["cache-control"] == "no-store"
        refused = await client.put("/api/v2/availability/settings", headers={**WRITE, "x-test-role": "confirmed"},
                                   json={"recheck_days": 10, "expected_revision": 0})
        assert refused.status_code == 403
        for body in ({"recheck_days": -1, "expected_revision": 0}, {"recheck_days": 366, "expected_revision": 0},
                     {"recheck_days": 1.5, "expected_revision": 0}, {"recheck_days": 10}):
            assert (await client.put("/api/v2/availability/settings", headers=admin, json=body)).status_code == 422, body
        saved = await client.put("/api/v2/availability/settings", headers=admin,
                                 json={"recheck_days": 90, "expected_revision": 0})
        assert saved.status_code == 200 and saved.json()["recheck_days"] == 90 and saved.json()["revision"] == 1
        stale = await client.put("/api/v2/availability/settings", headers=admin,
                                 json={"recheck_days": 5, "expected_revision": 0})
        assert stale.status_code == 409
        never = await client.put("/api/v2/availability/settings", headers=admin,
                                 json={"recheck_days": 0, "expected_revision": 1})
        assert never.json()["recheck_days"] == 0
        # A write from another site is refused, like every other write.
        assert (await client.put("/api/v2/availability/settings", headers={"origin": "https://evil.example", "x-test-role": "admin"},
                                 json={"recheck_days": 5, "expected_revision": 2})).status_code == 403
        assert (await client.get("/api/v2/availability/settings", headers=admin)).json()["recheck_days"] == 0


@pytest.mark.asyncio
async def test_a_product_page_lists_where_it_is_withdrawn_bounded_and_public(db, served):
    _retailer, (nord, sud), product = await seed(db)
    async with served as client:
        empty = await client.get(f"/api/v2/availability/products/{product}")
        assert empty.status_code == 200 and empty.json() == {"stores": [], "truncated": False}
        await mark(db, product, nord)
        await age(db, product, nord, 4)
        listed = (await client.get(f"/api/v2/availability/products/{product}")).json()
        assert [row["store_id"] for row in listed["stores"]] == [nord]
        row = listed["stores"][0]
        assert set(row) == {"store_id", "store_name", "city", "retailer", "sales_channel", "since", "checked", "next_check"}
        assert row["store_name"] == "Nord" and row["sales_channel"] == "drive" and row["retailer"] == "Test"
        await db.execute("UPDATE v2_availability_settings SET recheck_days=0")
        assert (await client.get(f"/api/v2/availability/products/{product}")).json()["stores"][0]["next_check"] is None
        await db.execute("UPDATE v2_stores SET active=false WHERE id=$1", nord)
        assert (await client.get(f"/api/v2/availability/products/{product}")).json()["stores"] == []
        await db.execute("UPDATE v2_stores SET active=true WHERE id=$1", nord)
        for bad in ("0", "-3", str(2**63)):
            assert (await client.get(f"/api/v2/availability/products/{bad}")).status_code == 422
        assert (await client.get("/api/v2/availability/products/abc")).status_code == 422
        # Bounded in SQL: many stores never make a long answer.
        for number in range(availability.MAX_STORES + 5):
            store = await db.fetchval(
                "INSERT INTO v2_stores(retailer_id,name) SELECT retailer_id,$1 FROM v2_stores WHERE id=$2 RETURNING id",
                f"Magasin {number}", sud)
            await mark(db, product, store)
        long = (await client.get(f"/api/v2/availability/products/{product}")).json()
        assert len(long["stores"]) == availability.MAX_STORES and long["truncated"] is True


@pytest.mark.asyncio
async def test_an_administrator_can_make_a_connector_look_again(db, served):
    _retailer, (nord, sud), product = await seed(db)
    await mark(db, product, nord)
    await mark(db, product, sud)
    url = f"/api/v2/availability/products/{product}/stores/{nord}"
    async with served as client:
        assert (await client.delete(url, headers={**WRITE, "x-test-role": "confirmed"})).status_code == 403
        assert (await client.delete(url, headers=WRITE)).status_code == 403
        assert await held(db, product, nord)
        assert (await client.delete(url + "?channel=teleport", headers={**WRITE, "x-test-role": "admin"})).status_code == 422
        assert (await client.delete(f"/api/v2/availability/products/0/stores/{nord}",
                                    headers={**WRITE, "x-test-role": "admin"})).status_code == 422
        done = await client.delete(url, headers={**WRITE, "x-test-role": "admin"})
        assert done.status_code == 200 and [row["store_id"] for row in done.json()["stores"]] == [sud]
        assert not await held(db, product, nord) and await held(db, product, sud)


@pytest.mark.asyncio
async def test_the_basket_leaves_out_a_price_from_a_store_that_no_longer_sells_the_product(db, served):
    retailer, (nord, sud), product = await seed(db)
    body = {"items": [{"kind": "product", "id": product}]}
    user = await db.fetchval(
        "INSERT INTO v2_users(username,username_key,password_hash,role) VALUES('ana','ana','x','confirmed') RETURNING id")
    headers = {**WRITE, "x-test-user": str(user)}

    async def fetch():
        answer = await served.post("/api/v2/basket/prices", headers=headers, json=body)
        assert answer.status_code == 200, answer.text
        return answer.json()["prices"][str(product)]
    async with served:
        before = await fetch()
        assert {price["store_id"] for price in before["latest_by_store"]} == {nord, sud}
        assert before["withdrawn_count"] == 0
        await mark(db, product, nord)
        after = await fetch()
        assert [price["store_id"] for price in after["latest_by_store"]] == [sud]
        assert after["withdrawn_count"] == 1, "the basket can say how many prices were left out"
        # The history is kept: the withdrawn store's price is still on the product's own page.
        assert await db.fetchval("SELECT count(*) FROM v2_price_observations WHERE store_id=$1", nord) == 1
        await db.execute(
            "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,source,price,observed_at,sales_channel) "
            "VALUES($1,$2,$3,'manual',1.10,now() + interval '1 minute','drive')", product, retailer, nord)
        back = await fetch()
        assert {price["store_id"] for price in back["latest_by_store"]} == {nord, sud}
        assert back["withdrawn_count"] == 0, "seen again after the check: no longer left out"
