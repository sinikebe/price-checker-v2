"""Credits for every price shown: product and group pages, visitors' allowance, administrators' settings."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import pytest
import pytest_asyncio
from conftest import REAL_VISITOR_KEY

from app.api.v2 import catalogue, prices
from app.api.v2 import credits as credits_api
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app
from app.services import v2_basket_credits as credits

pytestmark = pytest.mark.skipif(not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required")


@pytest_asyncio.fixture
async def config(monkeypatch, tmp_path):
    monkeypatch.setenv("PRICE_CHECKER_V2_STATE_DIR", str(tmp_path))
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_credits_" + secrets.token_hex(5)
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


@pytest.fixture
def clock(monkeypatch):
    state = {"now": datetime(2026, 11, 2, 9, 30, tzinfo=ZoneInfo("Europe/Paris"))}
    monkeypatch.setattr(credits, "paris_now", lambda: state["now"])
    return state


@pytest.fixture
def connected(monkeypatch, config, clock):
    async def connect():
        return await connect_v2(config)
    for module in (prices, catalogue, credits_api):
        monkeypatch.setattr(module, "_connect", connect)
    return config


def client(address="192.0.2.10"):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(address, 443), raise_app_exceptions=False),
                             base_url="https://test")


async def sql(config, query, *args):
    connection = await connect_v2(config)
    try:
        return await connection.fetch(query, *args)
    finally:
        await connection.close()


async def session(config, name, role="confirmed"):
    """A real account with a browser session: the cookie to send."""
    token = secrets.token_urlsafe(32)
    user_id = (await sql(config, "INSERT INTO v2_users(username,username_key,password_hash,role) VALUES($1,$1,'x',$2) RETURNING id",
                         name, role))[0]["id"]
    await sql(config, "INSERT INTO v2_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
              hashlib.sha256(token.encode()).hexdigest(), user_id)
    return user_id, {"pc_v2_session": token}


async def seed(config):
    """A group of three products, two of them with prices, at one store."""
    retailer = (await sql(config, "INSERT INTO v2_retailers(code,name) VALUES('test','Test') RETURNING id"))[0]["id"]
    store = (await sql(config, "INSERT INTO v2_stores(retailer_id,name,city,postal_code) VALUES($1,'Nord','Paris','75001') RETURNING id",
                       retailer))[0]["id"]
    products = []
    for name in ("Lait A", "Lait B", "Lait C"):
        products.append((await sql(config, "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
                                   json.dumps({"brand": "Test", "name": name, "group": "Lait", "quantity": "1 L"})))[0]["id"])
    for product in products[:2]:
        await sql(config, "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,source,price,observed_at) "
                  "VALUES($1,$2,$3,'manual',1.10,now())", product, retailer, store)
    return products


async def amounts(config, daily_grant=50, hold_max=100, visitor_daily=10):
    await sql(config, "UPDATE v2_credit_settings SET daily_grant=$1,hold_max=$2,visitor_daily=$3", daily_grant, hold_max, visitor_daily)


async def balance(config, user_id):
    rows = await sql(config, "SELECT balance FROM v2_basket_credits WHERE user_id=$1", user_id)
    return rows[0]["balance"] if rows else None


@pytest.mark.asyncio
async def test_a_product_page_costs_one_credit_and_a_missing_product_nothing(connected):
    config = connected
    products = await seed(config)
    ana, cookies = await session(config, "ana")
    async with client() as http:
        http.cookies.update(cookies)
        first = await http.get(f"/api/v2/prices/products/{products[0]}")
        assert first.status_code == 200, first.text
        assert first.headers["cache-control"] == "no-store"
        assert first.json()["credits"]["balance"] == 49 and len(first.json()["latest_by_store"]) == 1
        assert (await http.get(f"/api/v2/prices/products/{products[0]}")).json()["credits"]["balance"] == 48, "each fetch is paid"
        assert (await http.get("/api/v2/prices/products/999999")).status_code == 404
        state = (await http.get("/api/v2/credits")).json()
        assert state == {"balance": 48, "daily_grant": 50, "hold_max": 100, "next_grant_on": "2026-11-03",
                         "unlimited": False, "visitor": False}
    assert await balance(config, ana) == 48


@pytest.mark.asyncio
async def test_a_group_page_says_its_cost_and_never_charges_more(connected):
    config = connected
    products = await seed(config)
    ana, cookies = await session(config, "ana")
    async with client() as http:
        http.cookies.update(cookies)
        detail = (await http.get("/api/v2/catalogue/categories/Lait")).json()
        assert len(detail["products"]) == 3 and detail["observations"] == []
        assert detail["prices_cost"] == 2, "the product without a price costs nothing"
        assert await balance(config, ana) is None, "opening the page spends nothing"
        changed = await http.get("/api/v2/catalogue/prices/category", params={"name": "Lait", "max_cost": 1})
        assert changed.status_code == 409 and changed.json()["detail"]["cost"] == 2
        paid = await http.get("/api/v2/catalogue/prices/category", params={"name": "Lait", "max_cost": 2})
        assert paid.status_code == 200, paid.text
        assert (paid.json()["cost"], paid.json()["credits"]["balance"]) == (2, 48)
        assert {row["product_id"] for row in paid.json()["observations"]} == set(products[:2])
        assert (await http.get("/api/v2/catalogue/prices/category", params={"name": "Nothing", "max_cost": 5})).status_code == 404
        assert (await http.get("/api/v2/catalogue/prices/category", params={"name": "Lait", "max_cost": 5000})).status_code == 422
    assert await balance(config, ana) == 48


@pytest.mark.asyncio
async def test_without_enough_credits_nothing_is_shown_or_spent(connected):
    config = connected
    products = await seed(config)
    await amounts(config, daily_grant=1, hold_max=1)
    ana, cookies = await session(config, "ana")
    async with client() as http:
        http.cookies.update(cookies)
        group = await http.get("/api/v2/catalogue/prices/category", params={"name": "Lait", "max_cost": 2})
        assert group.status_code == 429
        assert (group.json()["detail"]["cost"], group.json()["detail"]["credits"]["balance"]) == (2, 1)
        assert int(group.headers["retry-after"]) > 0
        assert (await http.get(f"/api/v2/prices/products/{products[0]}")).status_code == 200
        refused = await http.get(f"/api/v2/prices/products/{products[0]}")
        assert refused.status_code == 429 and "observations" not in refused.text
        assert refused.json()["detail"]["code"] == "no_credits"
    assert await balance(config, ana) == 0


@pytest.mark.asyncio
async def test_visitors_have_a_small_daily_allowance_per_address(connected, clock, monkeypatch):
    config = connected
    monkeypatch.setattr(credits_api, "_visitor_key", REAL_VISITOR_KEY)
    products = await seed(config)
    await amounts(config, visitor_daily=3)
    async with client("192.0.2.10") as first, client("192.0.2.20") as second:
        state = (await first.get("/api/v2/credits")).json()
        assert (state["visitor"], state["balance"], state["daily_grant"]) == (True, 3, 3)
        for left in (2, 1):
            answer = await first.get(f"/api/v2/prices/products/{products[0]}")
            assert answer.status_code == 200 and answer.json()["credits"]["balance"] == left
        group = await first.get("/api/v2/catalogue/prices/category", params={"name": "Lait", "max_cost": 2})
        assert group.status_code == 429, "2 views asked, 1 left: refused and not counted"
        assert (await first.get(f"/api/v2/prices/products/{products[0]}")).json()["credits"]["balance"] == 0
        out = await first.get(f"/api/v2/prices/products/{products[0]}")
        assert out.status_code == 429 and "connectez-vous" in out.json()["detail"]["message"]
        assert (await second.get(f"/api/v2/prices/products/{products[0]}")).status_code == 200, "another address, its own views"
        clock["now"] = clock["now"].replace(day=3)
        assert (await first.get(f"/api/v2/prices/products/{products[0]}")).json()["credits"]["balance"] == 2, "a new day"
    rows = await sql(config, "SELECT key,day FROM v2_visitor_credits")
    assert all(len(row["key"]) == 64 and "192.0.2" not in row["key"] for row in rows), "never the address itself"
    clock["now"] = clock["now"].replace(day=5)
    async with client("192.0.2.30") as third:
        await third.get(f"/api/v2/prices/products/{products[0]}")
    assert {row["day"].day for row in await sql(config, "SELECT day FROM v2_visitor_credits")} == {5}, "older days are deleted"
    await amounts(config, visitor_daily=0)
    async with client("192.0.2.40") as closed:
        assert (await closed.get(f"/api/v2/prices/products/{products[0]}")).status_code == 429, "0: an account is needed"


@pytest.mark.asyncio
async def test_administrators_are_not_counted_and_set_the_amounts(connected):
    config = connected
    products = await seed(config)
    root, root_cookies = await session(config, "root", "admin")
    ana, ana_cookies = await session(config, "ana")
    async with client() as http:
        http.cookies.update(root_cookies)
        for _ in range(3):
            answer = await http.get(f"/api/v2/prices/products/{products[0]}")
            assert answer.json()["credits"]["unlimited"] is True
        settings = (await http.get("/api/v2/credits/settings")).json()
        assert (settings["daily_grant"], settings["hold_max"], settings["visitor_daily"]) == (50, 100, 10)
        assert settings["bounds"]["hold_max"] == {"min": 1, "max": 10000}
        change = {"daily_grant": 20, "hold_max": 30, "visitor_daily": 0, "expected_revision": settings["revision"]}
        saved = await http.put("/api/v2/credits/settings", json=change, headers={"origin": "https://test"})
        assert saved.status_code == 200 and saved.json()["daily_grant"] == 20
        stale = await http.put("/api/v2/credits/settings", json=change, headers={"origin": "https://test"})
        assert stale.status_code == 409
        for bad in ({"daily_grant": -1}, {"hold_max": 0}, {"visitor_daily": 1001}, {"daily_grant": "x"}):
            refused = await http.put("/api/v2/credits/settings", json={**change, "expected_revision": 1, **bad},
                                     headers={"origin": "https://test"})
            assert refused.status_code == 422, bad
        foreign = await http.put("/api/v2/credits/settings", json={**change, "expected_revision": 1},
                                 headers={"origin": "https://elsewhere.test"})
        assert foreign.status_code == 403
    assert await balance(config, root) is None
    async with client() as http:
        http.cookies.update(ana_cookies)
        assert (await http.get("/api/v2/credits/settings")).status_code == 403
        assert (await http.put("/api/v2/credits/settings", json={**change, "expected_revision": 1},
                               headers={"origin": "https://test"})).status_code == 403
        assert (await http.get("/api/v2/credits")).json()["balance"] == 20, "the new daily grant"


@pytest.mark.asyncio
async def test_a_page_from_another_site_cannot_spend_credits(connected):
    config = connected
    products = await seed(config)
    ana, cookies = await session(config, "ana")
    async with client() as http:
        http.cookies.update(cookies)
        cross = await http.get(f"/api/v2/prices/products/{products[0]}", headers={"sec-fetch-site": "cross-site"})
        assert cross.status_code == 403
        cross = await http.get("/api/v2/catalogue/prices/category", params={"name": "Lait", "max_cost": 2},
                               headers={"origin": "https://elsewhere.test"})
        assert cross.status_code == 403
    assert await balance(config, ana) is None
