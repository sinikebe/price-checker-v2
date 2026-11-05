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

from app.api.v2 import catalogue, prices, products as products_api
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
    for module in (prices, catalogue, credits_api, products_api):
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
        assert state == {"balance": 48, "bonus": 0, "rewards": {"price": 5, "product": 10, "recipe": 10},
                         "daily_grant": 50, "hold_max": 100, "next_grant_on": "2026-11-03",
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
        # Each reading names its store and place, so the site-wide store filter can apply in the browser.
        reading = paid.json()["observations"][0]
        assert {"store_id", "city", "postal_code", "online", "sales_channel"} <= set(reading)
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
        change = {"daily_grant": 20, "hold_max": 30, "visitor_daily": 0, "reward_price": 5, "reward_product": 10,
                  "reward_recipe": 10, "expected_revision": settings["revision"]}
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


# --- Contribution credits ----------------------------------------------------------------------

def test_daily_credits_go_first_then_contribution_credits():
    # The SQL of `spend`, checked through its arithmetic: what is left of each part.
    def spend(balance, bonus, cost):
        if balance + bonus < cost:
            return None
        used = min(balance, cost)
        return balance - used, bonus - (cost - used)
    assert spend(5, 30, 3) == (2, 30), "the daily credits pay first"
    assert spend(2, 30, 5) == (0, 27), "then the contribution credits"
    assert spend(0, 3, 4) is None, "not enough in all: nothing spent"


@pytest.mark.asyncio
async def test_a_validated_price_earns_contribution_credits_once_and_they_are_spent_last(connected):
    config = connected
    products = await seed(config)
    await amounts(config, daily_grant=2, hold_max=2)
    ana, ana_cookies = await session(config, "ana")
    root, root_cookies = await session(config, "root", "admin")
    retailer, store = (await sql(config, "SELECT retailer_id,id FROM v2_stores LIMIT 1"))[0].values()
    draft = (await sql(config, "INSERT INTO v2_price_drafts(author_id,product_id,retailer_id,store_id,entry_kind,price,observed_at) "
                       "VALUES($1,$2,$3,$4,'manual',2.30,now()) RETURNING id", ana, products[2], retailer, store))[0]["id"]
    async with client() as http:
        http.cookies.update(root_cookies)
        approved = await http.post(f"/api/v2/prices/drafts/{draft}/approve", headers={"origin": "https://test"})
        assert approved.status_code == 200, approved.text
        again = await http.post(f"/api/v2/prices/drafts/{draft}/approve", headers={"origin": "https://test"})
        assert again.status_code == 404, "a contribution is validated once, and rewarded once"
    rows = await sql(config, "SELECT bonus,balance FROM v2_basket_credits WHERE user_id=$1", ana)
    assert rows[0]["bonus"] == 5
    async with client() as http:
        http.cookies.update(ana_cookies)
        state = (await http.get("/api/v2/credits")).json()
        assert (state["balance"], state["bonus"], state["rewards"]) == (2, 5, {"price": 5, "product": 10, "recipe": 10})
        for expected in ((1, 5), (0, 5), (0, 4)):
            answer = await http.get(f"/api/v2/prices/products/{products[0]}")
            assert (answer.json()["credits"]["balance"], answer.json()["credits"]["bonus"]) == expected
        listed = (await http.get("/api/v2/credits/rewards")).json()
        assert listed["earned_total"] == 5 and [(item["kind"], item["credits"]) for item in listed["rewards"]] == [("price", 5)]
    async with client() as http:
        assert (await http.get("/api/v2/credits/rewards")).status_code == 401


@pytest.mark.asyncio
async def test_contribution_credits_have_no_limit_never_expire_and_are_not_given_to_administrators(connected, clock):
    config = connected
    ana, _ = await session(config, "ana")
    root, _ = await session(config, "root", "admin")
    connection = await connect_v2(config)
    try:
        async with connection.transaction():
            for contribution in range(1, 31):  # 30 recipes of 10 credits: far beyond the holding limit
                assert await credits.reward(connection, ana, "recipe", contribution) == 10
            assert await credits.reward(connection, ana, "recipe", 1) == 0, "the same contribution is rewarded once"
            assert await credits.reward(connection, ana, "product", 1) == 10, "another kind is another contribution"
            assert await credits.reward(connection, root, "price", 99) == 0, "administrators are not counted"
            assert await credits.reward(connection, ana, "unknown", 5) == 0
    finally:
        await connection.close()
    assert (await sql(config, "SELECT bonus FROM v2_basket_credits WHERE user_id=$1", ana))[0]["bonus"] == 310
    assert not await sql(config, "SELECT 1 FROM v2_basket_credits WHERE user_id=$1", root)
    clock["now"] = clock["now"].replace(month=12)  # a month later: still there, and the daily grant stays capped apart
    connection = await connect_v2(config)
    try:
        async with connection.transaction():
            state = await credits.lock_and_refill(connection, ana, await credits.settings(connection))
    finally:
        await connection.close()
    assert (state["balance"], state["bonus"]) == (50, 310)
    await sql(config, "DELETE FROM v2_users WHERE id=$1", ana)
    assert not await sql(config, "SELECT 1 FROM v2_credit_rewards"), "they go with the account"


@pytest.mark.asyncio
async def test_a_validated_product_earns_credits_and_the_amounts_are_settings(connected):
    config = connected
    ana, _ = await session(config, "ana")
    root, root_cookies = await session(config, "root", "admin")
    data = {"name": "Riz", "brand": "Test", "package": "Sachet", "quantity": "1 kg"}
    draft = (await sql(config, "INSERT INTO v2_product_drafts(author_id,data) VALUES($1,$2::jsonb) RETURNING id",
                       ana, json.dumps(data)))[0]["id"]
    async with client() as http:
        http.cookies.update(root_cookies)
        settings = (await http.get("/api/v2/credits/settings")).json()
        assert (settings["reward_price"], settings["reward_product"], settings["reward_recipe"]) == (5, 10, 10)
        change = {key: settings[key] for key in ("daily_grant", "hold_max", "visitor_daily")}
        change |= {"reward_price": 2, "reward_product": 7, "reward_recipe": 0, "expected_revision": settings["revision"]}
        assert (await http.put("/api/v2/credits/settings", json=change, headers={"origin": "https://test"})).status_code == 200
        bad = await http.put("/api/v2/credits/settings", json={**change, "reward_price": 1001, "expected_revision": settings["revision"] + 1},
                             headers={"origin": "https://test"})
        assert bad.status_code == 422
        approved = await http.post(f"/api/v2/products/drafts/{draft}/approve", json={"revision": 1}, headers={"origin": "https://test"})
        assert approved.status_code == 200, approved.text
    assert (await sql(config, "SELECT bonus FROM v2_basket_credits WHERE user_id=$1", ana))[0]["bonus"] == 7
    connection = await connect_v2(config)
    try:
        async with connection.transaction():
            assert await credits.reward(connection, ana, "recipe", 4) == 0, "0: recipes earn nothing now"
    finally:
        await connection.close()
