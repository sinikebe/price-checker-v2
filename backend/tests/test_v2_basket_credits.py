"""Credits: the grant rules, and one credit per line for a successful fetch of basket prices."""

from __future__ import annotations

import json
import os
import secrets
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import pytest
import pytest_asyncio
from fastapi import HTTPException

from app.api.v2 import basket, prices
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app
from app.services import v2_basket_credits as credits

MONDAY = date(2026, 11, 2)


CFG = {"daily_grant": 50, "hold_max": 100, "visitor_daily": 10}


def test_a_day_grants_fifty_and_only_once():
    assert credits.refilled(0, None, MONDAY, CFG) == (50, MONDAY)
    assert credits.refilled(50, MONDAY, MONDAY, CFG) == (50, MONDAY)
    assert credits.refilled(2, MONDAY, MONDAY, CFG) == (2, MONDAY)


def test_unused_credits_carry_over_up_to_the_limit_and_the_rest_is_lost():
    balance, granted_on = credits.refilled(0, None, MONDAY, CFG)
    balance, granted_on = credits.refilled(balance, granted_on, date(2026, 11, 3), CFG)
    assert balance == 100
    balance, granted_on = credits.refilled(balance, granted_on, date(2026, 11, 4), CFG)
    assert balance == 100, "nothing beyond the holding limit"
    assert credits.refilled(70, MONDAY, date(2026, 11, 3), CFG)[0] == 100, "70 + 50: the extra 20 are lost"
    # Days without any visit do not pile up grants: only that day's grant.
    assert credits.refilled(0, MONDAY, date(2026, 11, 9), CFG)[0] == 50
    # A lower limit set later never takes credits away.
    assert credits.refilled(150, MONDAY, date(2026, 11, 3), CFG)[0] == 150


def test_the_amounts_follow_the_settings():
    small = {"daily_grant": 5, "hold_max": 8, "visitor_daily": 0}
    assert credits.refilled(0, None, MONDAY, small) == (5, MONDAY)
    assert credits.refilled(5, MONDAY, date(2026, 11, 3), small)[0] == 8
    assert credits.public_state(3, MONDAY, small, 4) == {
        "balance": 3, "bonus": 4, "rewards": {"price": 5, "product": 10, "recipe": 10},
        "daily_grant": 5, "hold_max": 8, "next_grant_on": "2026-11-03", "unlimited": False, "visitor": False}
    assert credits.visitor_state(2, MONDAY, CFG)["visitor"] is True


pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)
WRITE = {"origin": "https://test"}


@pytest_asyncio.fixture
async def config():
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_basket_" + secrets.token_hex(5)
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
    """A movable Paris clock for the grant rules."""
    state = {"now": datetime(2026, 11, 2, 9, 30, tzinfo=ZoneInfo("Europe/Paris"))}
    monkeypatch.setattr(credits, "paris_now", lambda: state["now"])
    return state


@pytest.fixture
def served(monkeypatch, config, clock):
    async def connect():
        return await connect_v2(config)

    async def session_user(_connection, request):
        number = request.headers.get("x-test-user")
        if not number:
            raise HTTPException(status_code=401, detail="Connectez-vous.")
        return {"id": int(number), "username": "u" + number, "role": request.headers.get("x-test-role", "confirmed")}
    monkeypatch.setattr(basket, "_connect", connect)
    monkeypatch.setattr(basket, "_session_user", session_user)
    monkeypatch.setattr(prices, "_connect", connect)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="https://test")


async def seed(config):
    """Two accounts, one store, and a few products with prices."""
    connection = await connect_v2(config)
    try:
        users = [await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES($1,$1,'x','confirmed') RETURNING id", name) for name in ("ana", "ben")]
        retailer = await connection.fetchval(
            "INSERT INTO v2_retailers(code,name) VALUES('test','Test') RETURNING id")
        stores = [await connection.fetchval(
            "INSERT INTO v2_stores(retailer_id,name,city,postal_code) VALUES($1,$2,'Paris','75001') RETURNING id",
            retailer, name) for name in ("Nord", "Sud")]
        products = []
        for name, group in (("Lait A", "Lait"), ("Lait B", "Lait"), ("Pâtes", "Pâtes")):
            product_id = await connection.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
                json.dumps({"brand": "Test", "name": name, "group": group, "quantity": "1 L"}))
            products.append(product_id)
            for number, store in enumerate(stores):
                await connection.execute(
                    "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,source,price,observed_at) "
                    "VALUES($1,$2,$3,'manual',$4,now())", product_id, retailer, store, 1 + number)
        return users, stores, products
    finally:
        await connection.close()


async def amounts(config, daily_grant, hold_max, visitor_daily=10):
    connection = await connect_v2(config)
    try:
        await connection.execute(
            "UPDATE v2_credit_settings SET daily_grant=$1,hold_max=$2,visitor_daily=$3", daily_grant, hold_max, visitor_daily)
    finally:
        await connection.close()


async def balance(config, user_id):
    connection = await connect_v2(config)
    try:
        return await connection.fetchval("SELECT balance FROM v2_basket_credits WHERE user_id=$1", user_id)
    finally:
        await connection.close()


def acting(user_id):
    return {**WRITE, "x-test-user": str(user_id)}


@pytest.mark.asyncio
async def test_an_account_starts_with_the_grant_of_the_day_and_pays_one_credit_per_line(served, config):
    (ana, ben), _stores, products = await seed(config)
    async with served as client:
        first = await client.get("/api/v2/basket/credits", headers=acting(ana))
        assert first.status_code == 200 and first.headers["cache-control"] == "no-store"
        assert first.json() == {"balance": 50, "bonus": 0, "rewards": {"price": 5, "product": 10, "recipe": 10},
                                "daily_grant": 50, "hold_max": 100,
                                "next_grant_on": "2026-11-03", "unlimited": False, "visitor": False}
        body = {"items": [{"kind": "product", "id": products[0]}]}
        fetched = await client.post("/api/v2/basket/prices", headers=acting(ana), json=body)
        assert fetched.status_code == 200, fetched.text
        assert (fetched.json()["credits"]["balance"], fetched.json()["cost"]) == (49, 1)
        assert fetched.headers["cache-control"] == "no-store"
        three = {"items": [{"kind": "product", "id": products[0]}, {"kind": "group", "name": "Lait"},
                           {"kind": "product", "id": products[2]}]}
        fetched = await client.post("/api/v2/basket/prices", headers=acting(ana), json=three)
        assert (fetched.json()["credits"]["balance"], fetched.json()["cost"]) == (46, 3), "one credit per line, a group counts once"
        # Reading the credits never spends one, and every account has its own.
        assert (await client.get("/api/v2/basket/credits", headers=acting(ana))).json()["balance"] == 46
        assert (await client.get("/api/v2/basket/credits", headers=acting(ben))).json()["balance"] == 50
    assert await balance(config, ana) == 46


@pytest.mark.asyncio
async def test_a_next_day_grants_again_up_to_the_limit(served, config, clock):
    (ana, _ben), _stores, products = await seed(config)
    body = {"items": [{"kind": "product", "id": products[0]}]}
    async with served as client:
        seen = []
        for day in (2, 3, 4):  # nothing spent: 50, 100, still 100
            clock["now"] = clock["now"].replace(day=day)
            seen.append((await client.get("/api/v2/basket/credits", headers=acting(ana))).json()["balance"])
        assert seen == [50, 100, 100]
        assert (await client.post("/api/v2/basket/prices", headers=acting(ana), json=body)).status_code == 200
        clock["now"] = clock["now"].replace(day=5)
        assert (await client.get("/api/v2/basket/credits", headers=acting(ana))).json()["balance"] == 100, "99 + 50: the rest is lost"


@pytest.mark.asyncio
async def test_without_credit_the_fetch_is_refused_with_the_wait_and_costs_nothing(served, config, clock):
    (ana, _ben), _stores, products = await seed(config)
    await amounts(config, 5, 20)
    body = {"items": [{"kind": "product", "id": products[0]}]}
    async with served as client:
        for _ in range(4):
            assert (await client.post("/api/v2/basket/prices", headers=acting(ana), json=body)).status_code == 200
        two = {"items": [{"kind": "product", "id": products[0]}, {"kind": "product", "id": products[1]}]}
        short = await client.post("/api/v2/basket/prices", headers=acting(ana), json=two)
        assert short.status_code == 429 and short.json()["detail"]["cost"] == 2, "1 left, 2 needed"
        assert "2 crédits" in short.json()["detail"]["message"]
        assert (await client.post("/api/v2/basket/prices", headers=acting(ana), json=body)).status_code == 200
        refused = await client.post("/api/v2/basket/prices", headers=acting(ana), json=body)
        assert refused.status_code == 429
        detail = refused.json()["detail"]
        assert detail["code"] == "no_credits" and detail["cost"] == 1
        assert detail["credits"]["balance"] == 0 and detail["credits"]["next_grant_on"] == "2026-11-03"
        assert 14 * 3600 < int(refused.headers["retry-after"]) < 15 * 3600  # until Paris midnight
        assert await balance(config, ana) == 0
        clock["now"] = clock["now"].replace(day=3)
        assert (await client.post("/api/v2/basket/prices", headers=acting(ana), json=body)).status_code == 200
        assert await balance(config, ana) == 4


@pytest.mark.asyncio
async def test_a_failed_or_invalid_fetch_is_not_charged(served, config, monkeypatch):
    (ana, _ben), _stores, products = await seed(config)
    ok = {"items": [{"kind": "product", "id": products[0]}]}
    async with served as client:
        assert (await client.post("/api/v2/basket/prices", headers=WRITE, json=ok)).status_code == 401
        invalid = [
            {"items": []},
            {"items": [{"kind": "product", "id": 0}]},
            {"items": [{"kind": "product", "id": 2 ** 63}]},
            {"items": [{"kind": "group", "name": "  "}]},
            {"items": [{"kind": "group", "name": "x" * 101}]},
            {"items": [{"kind": "scope", "department": "d", "family": "f"}]},
            {"items": [{"kind": "other", "id": 1}]},
            {"items": [{"kind": "product", "id": 1}] * (basket.MAX_ITEMS + 1)},
        ]
        for body in invalid:
            refused = await client.post("/api/v2/basket/prices", headers=acting(ana), json=body)
            assert refused.status_code == 422, body

        async def broken(*_arguments):
            raise RuntimeError("database trouble")
        monkeypatch.setattr(basket, "_gather", broken)
        assert (await client.post("/api/v2/basket/prices", headers=acting(ana), json=ok)).status_code == 500
        monkeypatch.undo()
    assert await balance(config, ana) in (None, 50)  # nothing was spent


@pytest.mark.asyncio
async def test_the_fetch_needs_a_same_origin_write(served, config):
    (ana, _ben), _stores, products = await seed(config)
    body = {"items": [{"kind": "product", "id": products[0]}]}
    async with served as client:
        foreign = await client.post("/api/v2/basket/prices", json=body,
                                    headers={"origin": "https://elsewhere.test", "x-test-user": str(ana)})
        assert foreign.status_code == 403
    assert await balance(config, ana) in (None, 50)


@pytest.mark.asyncio
async def test_each_line_gets_its_candidates_and_prices_like_the_price_page(served, config):
    (ana, _ben), stores, products = await seed(config)
    milk_a, milk_b, pasta = products
    body = {"items": [
        {"kind": "product", "id": pasta},
        {"kind": "group", "name": "lait"},
        {"kind": "group", "name": "Inconnu"},
    ]}
    async with served as client:
        fetched = await client.post("/api/v2/basket/prices", headers=acting(ana), json=body)
        assert fetched.status_code == 200, fetched.text
        result = fetched.json()
        assert [line["product_ids"] for line in result["lines"]] == [[pasta], [milk_a, milk_b], []]
        assert not any(line["truncated"] for line in result["lines"])
        assert set(result["products"]) == {str(pasta), str(milk_a), str(milk_b)}
        assert set(result["products"][str(pasta)]) == {"id", "revision", "data"}
        assert result["products"][str(pasta)]["data"]["name"] == "Pâtes"
        for product_id in (pasta, milk_a, milk_b):
            published = (await client.get(f"/api/v2/prices/products/{product_id}")).json()
            mine = result["prices"][str(product_id)]
            assert mine["stores_truncated"] is False
            keys = set(mine["latest_by_store"][0])
            assert keys == {"id", "price", "observed_at", "retailer", "store_name", "store_id", "city",
                            "postal_code", "online", "sales_channel", "available", "correction_status",
                            "source_provider"}
            assert mine["latest_by_store"] == [
                {key: row[key] for key in keys} for row in published["latest_by_store"]]
            assert {row["store_id"] for row in mine["latest_by_store"]} == set(stores)


@pytest.mark.asyncio
async def test_a_replaced_product_is_priced_as_its_current_version_and_a_withdrawn_one_is_not(served, config):
    (ana, _ben), _stores, products = await seed(config)
    milk_a, milk_b, pasta = products
    connection = await connect_v2(config)
    try:
        successor = await connection.fetchval(
            "INSERT INTO v2_products(data,predecessor_id) VALUES($1::jsonb,$2) RETURNING id",
            json.dumps({"brand": "Test", "name": "Pâtes 2", "group": "Pâtes"}), pasta)
        snapshot = json.dumps({"name": "x"})
        await connection.execute(  # a merge takes precedence over a successor, like the product page
            "INSERT INTO v2_content_merges(kind,from_id,to_id,from_snapshot,to_snapshot,result_snapshot) "
            "VALUES('product',$1,$2,$3::jsonb,$3::jsonb,$3::jsonb)", milk_b, milk_a, snapshot)
        admin = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('root','root','x','admin') RETURNING id")
        await connection.execute(
            "INSERT INTO v2_content_withdrawals(kind,content_id,reason,withdrawn_by) VALUES('product',$1,'test',$2)",
            milk_a, admin)
    finally:
        await connection.close()
    body = {"items": [{"kind": "product", "id": pasta}, {"kind": "product", "id": milk_b},
                      {"kind": "product", "id": milk_a}, {"kind": "product", "id": 999999}]}
    async with served as client:
        result = (await client.post("/api/v2/basket/prices", headers=acting(ana), json=body)).json()
    # milk_b merged into milk_a, which is withdrawn: fails closed, like milk_a itself.
    assert [line["product_ids"] for line in result["lines"]] == [[successor], [], [], []]


@pytest.mark.asyncio
async def test_the_size_of_one_fetch_is_bounded(served, config, monkeypatch):
    (ana, _ben), _stores, products = await seed(config)
    monkeypatch.setattr(basket, "MAX_CANDIDATES", 1)
    body = {"items": [{"kind": "group", "name": "Lait"}, {"kind": "product", "id": products[2]}]}
    async with served as client:
        limited = (await client.post("/api/v2/basket/prices", headers=acting(ana), json=body)).json()
        assert limited["lines"][0] == {"product_ids": [products[0]], "truncated": True}
        assert limited["lines"][1]["truncated"] is False
        monkeypatch.setattr(basket, "MAX_CANDIDATES", 300)
        monkeypatch.setattr(basket, "MAX_PRODUCTS", 2)
        capped = (await client.post("/api/v2/basket/prices", headers=acting(ana), json=body)).json()
        assert capped["lines"][0]["product_ids"] == [products[0], products[1]]
        assert capped["lines"][1] == {"product_ids": [], "truncated": True}
        monkeypatch.setattr(basket, "MAX_PRODUCTS", 600)
        monkeypatch.setattr(basket, "MAX_STORES", 1)
        stores_capped = (await client.post("/api/v2/basket/prices", headers=acting(ana), json=body)).json()
        for entry in stores_capped["prices"].values():
            assert len(entry["latest_by_store"]) == 1 and entry["stores_truncated"] is True


@pytest.mark.asyncio
async def test_deleting_an_account_removes_its_credits(served, config):
    (ana, ben), _stores, _products = await seed(config)
    async with served as client:
        await client.get("/api/v2/basket/credits", headers=acting(ana))
        await client.get("/api/v2/basket/credits", headers=acting(ben))
    connection = await connect_v2(config)
    try:
        await connection.execute("DELETE FROM v2_users WHERE id=$1", ana)
        remaining = await connection.fetch("SELECT user_id FROM v2_basket_credits")
    finally:
        await connection.close()
    assert [row["user_id"] for row in remaining] == [ben]


@pytest.mark.asyncio
async def test_basket_requests_are_journaled_as_numbers_without_the_account(served, config):
    (ana, _ben), _stores, products = await seed(config)
    await amounts(config, 10, 20)
    body = {"items": [{"kind": "product", "id": products[0]}, {"kind": "group", "name": "Lait"}]}
    async with served as client:
        for _ in range(5):
            assert (await client.post("/api/v2/basket/prices", headers=acting(ana), json=body)).status_code == 200
        assert (await client.post("/api/v2/basket/prices", headers=acting(ana), json=body)).status_code == 429
    connection = await connect_v2(config)
    try:
        logged = await connection.fetch("SELECT level,source,event,connector,data FROM v2_logs WHERE source='basket' ORDER BY id")
    finally:
        await connection.close()
    assert [row["event"] for row in logged] == ["basket.prices.fetched"] * 5 + ["basket.prices.refused"]
    fetched = [json.loads(row["data"]) for row in logged[:5]]
    assert [entry["credits_left"] for entry in fetched] == [8, 6, 4, 2, 0], "two lines, two credits each time"
    assert fetched[0] == {"items": 2, "products": 2, "truncated": False, "credits_left": 8}
    assert json.loads(logged[5]["data"]) == {"reason": "no_credits"}
    assert all(row["connector"] is None for row in logged)
    assert all(set(json.loads(row["data"])) <= {"items", "products", "truncated", "credits_left", "reason"} for row in logged)


@pytest.mark.asyncio
async def test_an_administrator_has_no_credit_limit_but_a_sanity_cap(served, config, monkeypatch, tmp_path):
    monkeypatch.setenv("PRICE_CHECKER_V2_STATE_DIR", str(tmp_path))
    (ana, ben), _stores, products = await seed(config)
    body = {"items": [{"kind": "product", "id": products[0]}]}
    admin = {**acting(ana), "x-test-role": "admin"}
    async with served as client:
        state = (await client.get("/api/v2/basket/credits", headers=admin)).json()
        assert state["unlimited"] is True and state["balance"] == 100, "an older page still sees credits and keeps its button"
        for _ in range(8):
            answer = await client.post("/api/v2/basket/prices", headers=admin, json=body)
            assert answer.status_code == 200, answer.text
            assert answer.json()["credits"]["unlimited"] is True
        assert (await client.post("/api/v2/basket/prices", headers=acting(ben), json=body)).status_code == 200
        monkeypatch.setattr(basket, "ADMIN_FETCHES_PER_MINUTE", 8)
        runaway = await client.post("/api/v2/basket/prices", headers=admin, json=body)
        assert runaway.status_code == 429 and runaway.headers["retry-after"] == "60"
        assert "crédit" not in runaway.json()["detail"], "a rate cap, not a missing credit"
    assert await balance(config, ana) is None, "no credit is held, spent or granted for an administrator"
    assert await balance(config, ben) == 49, "a member still pays"
    connection = await connect_v2(config)
    try:
        logged = [json.loads(row["data"]) for row in await connection.fetch(
            "SELECT data FROM v2_logs WHERE event='basket.prices.fetched' ORDER BY id")]
    finally:
        await connection.close()
    assert [entry.get("unlimited") for entry in logged] == [True] * 8 + [None]
    assert "credits_left" not in logged[0] and logged[-1]["credits_left"] == 49


@pytest.mark.asyncio
async def test_the_role_comes_from_the_session_not_from_the_request(served, config):
    (ana, _ben), _stores, products = await seed(config)
    await amounts(config, 5, 20)
    body = {"items": [{"kind": "product", "id": products[0]}]}
    async with served as client:
        for _ in range(5):
            assert (await client.post("/api/v2/basket/prices", headers=acting(ana), json=body)).status_code == 200
        boasting = {**acting(ana), "x-role": "admin", "x-admin": "1"}
        assert (await client.post("/api/v2/basket/prices", headers=boasting, json=body)).status_code == 429
        assert (await client.get("/api/v2/basket/credits", headers=boasting)).json()["unlimited"] is False
