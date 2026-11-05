"""The demo basket: saved by an administrator with the prices the server reads, shown to anyone."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from fastapi import HTTPException

from app.api.v2 import demo_basket
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)
PATH = "/api/v2/demo-basket"
WRITE = {"origin": "https://test"}


@pytest_asyncio.fixture
async def config():
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_demo_basket_" + secrets.token_hex(5)
    root = await connect_v2(base)
    try:
        await root.execute('CREATE DATABASE "' + database + '"')
    finally:
        await root.close()
    configured = {**base, "database": database}
    try:
        await migrate_v2(configured)
        yield configured
    finally:
        root = await connect_v2(base)
        try:
            await root.execute('DROP DATABASE "' + database + '" WITH (FORCE)')
        finally:
            await root.close()


@pytest.fixture
def served(monkeypatch, config):
    async def connect():
        return await connect_v2(config)

    async def session_user(_connection, request):
        number = request.headers.get("x-test-user")
        if not number:
            raise HTTPException(status_code=401, detail="Connectez-vous.")
        return {"id": int(number), "username": "u" + number, "role": request.headers.get("x-test-role", "confirmed")}
    monkeypatch.setattr(demo_basket, "_connect", connect)
    monkeypatch.setattr(demo_basket, "_session_user", session_user)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="https://test")


async def seed(config):
    """An administrator, a member, one store with prices, and a withdrawn product."""
    connection = await connect_v2(config)
    try:
        users = {role: await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) VALUES($1,$1,'x',$2) RETURNING id",
            "u_" + role, role) for role in ("admin", "confirmed")}
        retailer = await connection.fetchval("INSERT INTO v2_retailers(code,name) VALUES('test','Test') RETURNING id")
        store = await connection.fetchval(
            "INSERT INTO v2_stores(retailer_id,name,city,postal_code) VALUES($1,'Nord','Lyon','69003') RETURNING id", retailer)
        products = {}
        for name, group in (("Lait A", "Lait"), ("Lait B", "Lait"), ("Pâtes", "Pâtes"), ("Retiré", "Retiré")):
            products[name] = await connection.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
                json.dumps({"brand": "Test", "name": name, "group": group, "quantity": "1 L"}))
            await connection.execute(
                "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,source,price,observed_at) "
                "VALUES($1,$2,$3,'manual',1.25,now())", products[name], retailer, store)
        await connection.execute(
            "INSERT INTO v2_content_withdrawals(kind,content_id,reason,withdrawn_by) VALUES('product',$1,'test',$2)",
            products["Retiré"], users["admin"])
        return users, store, products
    finally:
        await connection.close()


def acting(user_id, role="confirmed"):
    return {**WRITE, "x-test-user": str(user_id), "x-test-role": role}


def body(products, **extra):
    return {
        "title": "  Un mois   de courses ",
        "lines": [{"line": {"kind": "product", "product_id": products["Pâtes"]}, "quantity": {"amount": "2", "unit": "package"}},
                  {"line": {"kind": "group", "name": "Lait"}, "disabled": True}],
        "settings": {"advanced": True, "compare": "unit", "stores_off": ["7:drive"], "checked": ["group:lait"], "list_mode": "split"},
        **extra,
    }


@pytest.mark.asyncio
async def test_an_administrator_saves_a_basket_that_anyone_then_reads_with_the_prices_of_that_moment(served, config):
    users, store, products = await seed(config)
    async with served as client:
        empty = await client.get(PATH)
        assert empty.status_code == 200 and empty.json() == {"demo": None}
        assert (await client.put(PATH, headers=WRITE, json=body(products))).status_code == 401
        assert (await client.put(PATH, headers=acting(users["confirmed"]), json=body(products))).status_code == 403
        sent = body(products)
        sent["result"] = {"prices": {"1": "forged"}}  # the prices are the server's, never the browser's
        saved = await client.put(PATH, headers=acting(users["admin"], "admin"), json=sent)
        assert saved.status_code == 200, saved.text
        assert saved.json()["title"] == "Un mois de courses" and saved.json()["items"] == 2 and saved.json()["products"] == 3

        read = await client.get(PATH)
        assert read.status_code == 200 and read.headers["cache-control"] == "no-cache"
        demo = read.json()["demo"]
        assert demo["title"] == "Un mois de courses"
        content = demo["content"]
        pasta, milk = content["items"]
        assert (pasta["id"], pasta["data"]["name"], pasta["quantity"]) == (products["Pâtes"], "Pâtes", {"amount": "2", "unit": "package"})
        assert milk == {"kind": "group", "name": "Lait", "disabled": True}
        assert content["settings"] == {"advanced": True, "compare": "unit", "filters": {"storeIds": [], "cities": [], "departments": []},
                                       "stores_off": ["7:drive"], "units": {}, "checked": [], "list_mode": "split"}
        result = content["result"]
        assert [line["product_ids"] for line in result["lines"]] == [[products["Pâtes"]], sorted([products["Lait A"], products["Lait B"]])]
        rows = result["prices"][str(products["Pâtes"])]["latest_by_store"]
        assert [(row["store_id"], row["price"], row["city"]) for row in rows] == [(store, "1.25", "Lyon")]
        assert "forged" not in read.text

        again = await client.get(PATH, headers={"if-none-match": read.headers["etag"]})
        assert again.status_code == 304, "unchanged since the last read: nothing downloaded again"

        replaced = body(products, title="Autre exemple")
        replaced["lines"] = replaced["lines"][:1]
        assert (await client.put(PATH, headers=acting(users["admin"], "admin"), json=replaced)).status_code == 200
        changed = await client.get(PATH, headers={"if-none-match": read.headers["etag"]})
        assert changed.status_code == 200 and changed.json()["demo"]["title"] == "Autre exemple"

        assert (await client.delete(PATH, headers=acting(users["confirmed"]))).status_code == 403
        assert (await client.delete(PATH, headers=acting(users["admin"], "admin"))).status_code == 204
        assert (await client.get(PATH)).json() == {"demo": None}

    connection = await connect_v2(config)
    try:
        logged = [(row["event"], json.loads(row["data"])) for row in await connection.fetch(
            "SELECT event,data FROM v2_logs WHERE event LIKE 'basket.demo.%' ORDER BY id")]
    finally:
        await connection.close()
    assert logged == [("basket.demo.saved", {"items": 2, "products": 3}), ("basket.demo.saved", {"items": 1, "products": 1}),
                      ("basket.demo.removed", {})], "numbers only"


@pytest.mark.asyncio
async def test_a_basket_that_cannot_be_shown_as_it_is_is_refused(served, config, monkeypatch):
    users, _store, products = await seed(config)
    admin = acting(users["admin"], "admin")
    async with served as client:
        withdrawn = body(products)
        withdrawn["lines"].append({"line": {"kind": "product", "product_id": products["Retiré"]}})
        refused = await client.put(PATH, headers=admin, json=withdrawn)
        assert refused.status_code == 422 and "plus au catalogue" in refused.json()["detail"]
        twice = body(products)
        twice["lines"].append({"line": {"kind": "group", "name": "lait"}})
        assert (await client.put(PATH, headers=admin, json=twice)).status_code == 422
        assert (await client.put(PATH, headers=admin, json=body(products, title="   "))).status_code == 422
        assert (await client.put(PATH, headers=admin, json={**body(products), "lines": []})).status_code == 422
        monkeypatch.setattr(demo_basket, "MAX_STORED_BYTES", 500)
        large = await client.put(PATH, headers=admin, json=body(products))
        assert large.status_code == 422 and "trop de prix" in large.json()["detail"]
        assert (await client.get(PATH)).json() == {"demo": None}, "nothing was saved"
        cross = await client.put(PATH, headers={**admin, "origin": "https://elsewhere.example"}, json=body(products))
        assert cross.status_code == 403


@pytest.mark.asyncio
async def test_reads_and_saves_are_limited(served, config, monkeypatch):
    users, _store, products = await seed(config)
    monkeypatch.setattr(demo_basket, "READS_PER_MINUTE", 2)
    monkeypatch.setattr(demo_basket, "SAVES_PER_MINUTE", 1)
    admin = acting(users["admin"], "admin")
    async with served as client:
        assert [(await client.get(PATH)).status_code for _ in range(3)] == [200, 200, 429]
        assert (await client.put(PATH, headers=admin, json=body(products))).status_code == 200
        limited = await client.put(PATH, headers=admin, json=body(products))
        assert limited.status_code == 429 and limited.headers["retry-after"] == "60"


@pytest.mark.asyncio
async def test_a_demo_keeps_selections_and_refuses_free_text(served, config):
    users, _store, products = await seed(config)
    admin = acting(users["admin"], "admin")
    async with served as client:
        mixed = body(products)
        mixed["lines"].append({"line": {"kind": "selection", "name": "Tout", "include": [{"group": "Lait"}, {"group": "Pâtes"}]}})
        saved = await client.put(PATH, headers=admin, json=mixed)
        assert saved.status_code == 200, saved.text
        demo = (await client.get(PATH)).json()["demo"]
        selection = demo["content"]["items"][-1]
        assert selection == {"kind": "selection", "name": "Tout", "include": [{"group": "Lait"}, {"group": "Pâtes"}],
                             "exclude": [], "words": []}
        texted = body(products)
        texted["lines"].append({"line": {"kind": "text", "name": "Bougies"}})
        refused = await client.put(PATH, headers=admin, json=texted)
        assert refused.status_code == 422 and "texte libre" in refused.json()["detail"]
