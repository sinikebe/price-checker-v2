"""Barcode-only products: created on demand, kept out of the catalogue lists, completed by a proposal,
and removed when unused and nothing on our side points to them."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException

from app.api.v2 import basket, catalogue, product_references, products, shared_baskets
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app
from app.services import v2_product_references as references

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)
PATH = "/api/v2/product-references"
NUTELLA = "3017620422003"  # valid check digit
COKE = "5449000000996"


@pytest.fixture
async def setup(monkeypatch):
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    root = await connect_v2(base)
    database = "v2_references_" + secrets.token_hex(5)
    await root.execute('CREATE DATABASE "' + database + '"')
    await root.close()
    config = {**base, "database": database}
    await migrate_v2(config)
    connection = await connect_v2(config)
    users = {}
    for name, role in (("ana", "confirmed"), ("root", "admin")):
        users[name] = {"id": await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) VALUES($1,$1,'x',$2) RETURNING id", name, role),
            "role": role, "username": name}

    async def fake_connect():
        return await connect_v2(config)

    async def fake_user(_connection, request):
        return users.get(request.headers.get("x-test-user"))

    async def fake_session_user(connection_, request):
        user = await fake_user(connection_, request)
        if user is None:
            raise HTTPException(status_code=401, detail="Connectez-vous.")
        return user

    for module in (product_references, products, catalogue, basket, shared_baskets):
        monkeypatch.setattr(module, "_connect", fake_connect)
    for module in (product_references, products):
        monkeypatch.setattr(module, "_current_user", fake_user)
    for module in (product_references, basket, shared_baskets):
        monkeypatch.setattr(module, "_session_user", fake_session_user)
    monkeypatch.setattr(shared_baskets, "_live", shared_baskets._Live())
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test")
    try:
        yield client, connection, users
    finally:
        await client.aclose()
        await connection.close()
        root = await connect_v2(base)
        try:
            await root.execute('DROP DATABASE "' + database + '" WITH (FORCE)')
        finally:
            await root.close()


ANA, ROOT = {"x-test-user": "ana"}, {"x-test-user": "root"}


async def pwa_revision(connection) -> int:
    return await connection.fetchval("SELECT revision FROM v2_pwa_versions WHERE collection='products'")


@pytest.mark.asyncio
async def test_a_barcode_only_product_is_created_once_and_stays_out_of_the_catalogue(setup, monkeypatch):
    client, connection, _users = setup
    assert (await client.post(PATH, json={"ean": NUTELLA})).status_code == 401
    assert (await client.post(PATH, headers=ANA, json={"ean": "3017620422004"})).status_code == 422, "check digit"
    assert (await client.post(PATH, headers=ANA, json={"ean": "30176204"})).status_code == 422
    revision = await pwa_revision(connection)
    created = await client.post(PATH, headers=ANA, json={"ean": NUTELLA})
    assert created.status_code == 201, created.text
    product_id = created.json()["id"]
    assert created.json()["created"] is True
    row = await connection.fetchrow("SELECT data, off_reference FROM v2_products WHERE id=$1", product_id)
    assert json.loads(row["data"]) == {"ean": NUTELLA} and row["off_reference"] is True
    assert await pwa_revision(connection) == revision, "devices do not download the catalogue again"
    again = await client.post(PATH, headers=ANA, json={"ean": NUTELLA})
    assert again.status_code == 200 and again.json() == {"id": product_id, "created": False}
    # Out of the catalogue lists, but reachable by barcode and by its page.
    assert product_id not in {item["id"] for item in (await client.get("/api/v2/products")).json()}
    assert (await client.get("/api/v2/catalogue/categories")).json() == []
    assert (await client.get("/api/v2/catalogue/search", params={"q": NUTELLA})).json()["total"] == 0
    assert (await client.get(f"/api/v2/products/by-barcode/{NUTELLA}")).json() == {"kind": "product", "id": product_id}
    page = (await client.get(f"/api/v2/products/{product_id}")).json()
    assert page["off_reference"] is True and page["data"]["ean"] == NUTELLA and page["data"]["name"] == ""
    # A catalogue product with the barcode (padded) is returned instead of a new one.
    existing = await connection.fetchval(
        "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id", json.dumps({"name": "Coca", "brand": "Coca-Cola", "ean": "0" + COKE}))
    assert (await client.post(PATH, headers=ANA, json={"ean": COKE})).json() == {"id": existing, "created": False}
    monkeypatch.setattr(product_references, "CREATES_PER_HOUR", 3)
    limited = await client.post(PATH, headers=ANA, json={"ean": "4006381333931"})
    assert limited.status_code == 429


@pytest.mark.asyncio
async def test_an_approved_proposal_completes_the_barcode_only_product_in_place(setup):
    client, connection, users = setup
    product_id = (await client.post(PATH, headers=ANA, json={"ean": NUTELLA})).json()["id"]
    retailer = await connection.fetchval("INSERT INTO v2_retailers(code,name) VALUES('shop','Shop') RETURNING id")
    store = await connection.fetchval(
        "INSERT INTO v2_stores(retailer_id,name,city,postal_code) VALUES($1,'Shop Centre','Lyon','69001') RETURNING id", retailer)
    await connection.execute(
        "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,source,price,observed_at,sales_channel) "
        "VALUES($1,$2,$3,'manual',3.49,now(),'in_store')", product_id, retailer, store)
    data = {"name": "Pâte à tartiner", "brand": "Nutella", "package": "Pot", "quantity": "400 g", "ean": NUTELLA}
    draft = await connection.fetchrow(
        "INSERT INTO v2_product_drafts(author_id,data) VALUES($1,$2::jsonb) RETURNING id, revision", users["ana"]["id"], json.dumps(data))
    approved = await client.post(f"/api/v2/products/drafts/{draft['id']}/approve", headers={**ROOT, "origin": "https://test"},
                                 json={"revision": draft["revision"]})
    assert approved.status_code == 200, approved.text
    assert approved.json()["id"] == product_id and approved.json()["off_reference"] is False
    row = await connection.fetchrow("SELECT data, off_reference FROM v2_products WHERE id=$1", product_id)
    assert json.loads(row["data"])["name"] == "Pâte à tartiner" and row["off_reference"] is False
    assert await connection.fetchval("SELECT count(*) FROM v2_price_observations WHERE product_id=$1", product_id) == 1
    assert await connection.fetchval("SELECT event_type FROM v2_product_events WHERE product_id=$1", product_id) == "correction"
    assert product_id in {item["id"] for item in (await client.get("/api/v2/products")).json()}


@pytest.mark.asyncio
async def test_unused_barcode_only_products_with_nothing_on_our_side_are_removed(setup):
    client, connection, users = setup
    ids = {}
    for name, code in (("idle", NUTELLA), ("priced", COKE), ("recent", "4006381333931"), ("shared", "8410076472113")):
        ids[name] = (await client.post(PATH, headers=ANA, json={"ean": code})).json()["id"]
    await connection.execute("UPDATE v2_product_reference_uses SET last_used_at=now()-interval '40 days' WHERE product_id<>$1", ids["recent"])
    await connection.execute("UPDATE v2_products SET created_at=now()-interval '40 days'")
    await connection.execute("INSERT INTO v2_open_prices_sync_state(product_id,barcode,checked_at) VALUES($1,$2,now())", ids["idle"], NUTELLA)
    retailer = await connection.fetchval("INSERT INTO v2_retailers(code,name) VALUES('shop','Shop') RETURNING id")
    store = await connection.fetchval(
        "INSERT INTO v2_stores(retailer_id,name,city,postal_code) VALUES($1,'Shop Centre','Lyon','69001') RETURNING id", retailer)
    await connection.execute(
        "INSERT INTO v2_price_drafts(product_id,author_id,retailer_id,store_id,price,observed_at,entry_kind) VALUES($1,$2,$3,$4,1.10,now(),'manual')",
        ids["priced"], users["ana"]["id"], retailer, store)
    shared = await client.post("/api/v2/shared-baskets", headers=ANA, json={"name": "Courses", "lines": [
        {"line": {"kind": "product", "product_id": ids["shared"], "label": "Barquitas"}}]})
    assert shared.status_code == 201, shared.text
    assert shared.json()["lines"][0]["label"] == "Barquitas", "a barcode-only product takes the member's label"
    assert shared.json()["lines"][0]["product"]["off_reference"] is True

    await connection.execute("UPDATE v2_product_reference_settings SET unused_days=0")
    assert await references.purge_unused(connection) == 0, "0 keeps them forever"
    await connection.execute("UPDATE v2_product_reference_settings SET unused_days=30")
    assert await references.purge_unused(connection) == 1
    left = {row["id"] for row in await connection.fetch("SELECT id FROM v2_products WHERE off_reference")}
    assert left == {ids["priced"], ids["recent"], ids["shared"]}
    assert await connection.fetchval("SELECT count(*) FROM v2_open_prices_sync_state") == 0
    # Pricing a basket counts as a use.
    await connection.execute("UPDATE v2_product_reference_uses SET last_used_at=now()-interval '40 days'")
    priced = await client.post("/api/v2/basket/prices", headers=ANA, json={"items": [{"kind": "product", "id": ids["recent"]}]})
    assert priced.status_code == 200, priced.text
    assert await connection.fetchval(
        "SELECT last_used_at > now()-interval '1 minute' FROM v2_product_reference_uses WHERE product_id=$1", ids["recent"])


@pytest.mark.asyncio
async def test_the_cleanup_delay_is_an_administrator_setting(setup):
    client, _connection, _users = setup
    assert (await client.get(f"{PATH}/settings", headers=ANA)).status_code == 403
    current = (await client.get(f"{PATH}/settings", headers=ROOT)).json()
    assert current["unused_days"] == 90 and current["count"] == 0 and current["max"] == 3650
    for wrong in ({"unused_days": -1, "expected_revision": 0}, {"unused_days": 3651, "expected_revision": 0}):
        assert (await client.put(f"{PATH}/settings", headers=ROOT, json=wrong)).status_code == 422
    changed = await client.put(f"{PATH}/settings", headers=ROOT, json={"unused_days": 30, "expected_revision": current["revision"]})
    assert changed.status_code == 200 and changed.json()["unused_days"] == 30
    stale = await client.put(f"{PATH}/settings", headers=ROOT, json={"unused_days": 10, "expected_revision": current["revision"]})
    assert stale.status_code == 409
    assert (await client.put(f"{PATH}/settings", headers=ANA, json={"unused_days": 10, "expected_revision": 1})).status_code == 403


@pytest.mark.asyncio
async def test_search_results_are_marked_with_the_products_we_have(setup):
    client, connection, _users = setup
    ours = await connection.fetchval(
        "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id", json.dumps({"name": "Coca", "brand": "Coca-Cola", "ean": "0" + COKE}))
    reference = (await client.post(PATH, headers=ANA, json={"ean": NUTELLA})).json()["id"]
    found = await client.post("/api/v2/products/by-barcodes", json={"codes": [COKE, NUTELLA, "4006381333931", "nonsense"]})
    assert found.status_code == 200, found.text
    assert found.json() == {"matches": {COKE: ours, NUTELLA: reference}}
    assert (await client.post("/api/v2/products/by-barcodes", json={"codes": [COKE] * 21})).status_code == 422
