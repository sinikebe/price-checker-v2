"""One bookmarklet submission creates a private product and pending price safely."""

from __future__ import annotations

import json
import os
import secrets
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import pytest
import pytest_asyncio
from app.api.v2 import prices, products
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


@pytest_asyncio.fixture
async def isolated_config():
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_capture_" + secrets.token_hex(5)
    admin = await connect_v2(base)
    try:
        await admin.execute('CREATE DATABASE "' + database + '"')
    finally:
        await admin.close()
    config = {**base, "database": database}
    try:
        await migrate_v2(config)
        yield config
    finally:
        admin = await connect_v2(base)
        try:
            await admin.execute('DROP DATABASE "' + database + '" WITH (FORCE)')
        finally:
            await admin.close()


@pytest.mark.asyncio
async def test_capture_submits_product_and_price_once_with_independent_review(
    monkeypatch, isolated_config,
):
    config = isolated_config
    connection = await connect_v2(config)
    try:
        users = {}
        for key, role in (("author", "confirmed"), ("other", "visitor"), ("admin", "admin")):
            user_id = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES($1,$1,'test',$2) RETURNING id", "capture_" + key, role,
            )
            users[key] = {"id": user_id, "role": role, "username": key}

        async def fake_connect():
            return await connect_v2(config)

        async def fake_user(_connection, request):
            return users.get(request.headers.get("x-test-user"))

        for module in (prices, products):
            monkeypatch.setattr(module, "_connect", fake_connect)
            monkeypatch.setattr(module, "_current_user", fake_user)

        barcode = "3073781178005"
        day = datetime.now(ZoneInfo("Europe/Paris")).date().isoformat()
        item = {"ean": barcode, "name": "Disposable capture product",
                "brand": "Disposable", "package": "sachet", "quantity": "250 g"}
        price = {"retailer": "Disposable Shop", "store_name": "Centre",
                 "city": "Paris", "postal_code": "75001", "sales_channel": "in_store",
                 "price": "5.40", "observed_at": day,
                 "note": "Page produit : https://example.org/product"}
        body = {"ean": barcode, "source_url": "https://example.org/product",
                "product_data": item, "price": price}
        endpoint = "/api/v2/prices/capture-drafts"
        headers = {"x-test-user": "author"}
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://test"
        ) as client:
            assert (await client.post(endpoint, json=body)).status_code == 401
            assert (await client.post(endpoint, json={**body, "product_data": {**item, "ean": "12345678"}},
                                      headers=headers)).status_code == 422
            assert (await client.post(endpoint, json={**body, "price": {**price, "price": "-1"}},
                                      headers=headers)).status_code == 422
            assert await connection.fetchval("SELECT count(*) FROM v2_product_drafts") == 0
            assert await connection.fetchval("SELECT count(*) FROM v2_price_drafts") == 0

            sent = await client.post(endpoint, json=body, headers=headers)
            assert sent.status_code == 201, sent.text
            product_draft_id = sent.json()["product_draft_id"]
            price_draft_id = sent.json()["price_draft_id"]
            assert sent.json()["created_product_draft"] is True
            assert await connection.fetchval("SELECT count(*) FROM v2_products") == 0
            assert await connection.fetchval("SELECT count(*) FROM v2_price_observations") == 0
            stored = await connection.fetchrow(
                "SELECT product_id,product_draft_id,capture_ean,price,status,entry_kind,captured_via "
                "FROM v2_price_drafts WHERE id=$1", price_draft_id,
            )
            assert stored["product_id"] is None
            assert stored["product_draft_id"] == product_draft_id
            assert stored["capture_ean"] == barcode
            assert str(stored["price"]) == "5.40"
            assert stored["status"] == "draft"
            assert stored["entry_kind"] == "capture" and stored["captured_via"] == "bookmarklet"
            lookup = f"/api/v2/products/by-barcode/{barcode}"
            assert (await client.get(lookup, headers=headers)).json() == {
                "kind": "draft", "id": product_draft_id,
            }
            assert (await client.get(lookup, headers={"x-test-user": "other"})).status_code == 404
            assert (await client.get(f"/api/v2/products/drafts/{product_draft_id}",
                                     headers={"x-test-user": "other"})).status_code == 404
            own = await client.get(f"/api/v2/products/drafts/{product_draft_id}", headers=headers)
            assert own.json()["linked_prices"][0]["id"] == price_draft_id
            assert (await client.post(f"/api/v2/prices/drafts/{price_draft_id}/approve",
                                      headers={"x-test-user": "admin"})).status_code == 409

            attached = await client.post(endpoint, json={"ean": barcode,
                "product_draft_id": product_draft_id, "source_url": body["source_url"],
                "price": {**price, "price": "5.50", "sales_channel": "drive"}},
                headers=headers)
            assert attached.status_code == 201, attached.text
            assert attached.json()["created_product_draft"] is False
            assert attached.json()["product_draft_id"] == product_draft_id
            other_price_id = attached.json()["price_draft_id"]
            assert await connection.fetchval("SELECT count(*) FROM v2_product_drafts") == 1
            assert (await client.post(endpoint, json={"ean": barcode,
                "product_draft_id": product_draft_id, "source_url": body["source_url"],
                "price": price}, headers={"x-test-user": "other"})).status_code == 404
            assert await connection.fetchval("SELECT count(*) FROM v2_price_drafts") == 2

            approved = await client.post(
                f"/api/v2/products/drafts/{product_draft_id}/approve",
                json={"revision": 1}, headers={"x-test-user": "admin"},
            )
            assert approved.status_code == 200, approved.text
            product_id = approved.json()["id"]
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_price_drafts WHERE product_id=$1 "
                "AND product_draft_id IS NULL AND status='draft'", product_id,
            ) == 2
            assert await connection.fetchval("SELECT count(*) FROM v2_price_observations") == 0
            public_drafts = f"/api/v2/prices/products/{product_id}/drafts"
            assert (await client.get(public_drafts, headers={"x-test-user": "other"})).json() == []
            assert {row["id"] for row in (await client.get(public_drafts, headers=headers)).json()} == {
                price_draft_id, other_price_id,
            }
            assert (await client.post(f"/api/v2/prices/drafts/{other_price_id}/reject",
                                      headers={"x-test-user": "admin"})).status_code == 200
            approved_price = await client.post(
                f"/api/v2/prices/drafts/{price_draft_id}/approve",
                headers={"x-test-user": "admin"},
            )
            assert approved_price.status_code == 200, approved_price.text
            observations = (await client.get(f"/api/v2/prices/products/{product_id}")).json()["observations"]
            assert len(observations) == 1 and observations[0]["price"] == "5.40"
            assert (await client.post(endpoint, json=body, headers=headers)).status_code == 409

            rejected_barcode = "3073781178006"
            rejected_body = {**body, "ean": rejected_barcode,
                "product_data": {**item, "ean": rejected_barcode}}
            pending = await client.post(endpoint, json=rejected_body, headers=headers)
            assert pending.status_code == 201, pending.text
            rejected_draft_id = pending.json()["product_draft_id"]
            rejected_price_id = pending.json()["price_draft_id"]
            rejected = await client.post(
                f"/api/v2/products/drafts/{rejected_draft_id}/reject",
                json={"revision": 1}, headers={"x-test-user": "admin"},
            )
            assert rejected.status_code == 200, rejected.text
            assert await connection.fetchval(
                "SELECT status FROM v2_price_drafts WHERE id=$1", rejected_price_id,
            ) == "rejected"
            assert await connection.fetchval("SELECT count(*) FROM v2_price_observations") == 1

            changed_barcode = "3073781178007"
            changed_body = {**body, "ean": changed_barcode,
                "product_data": {**item, "ean": changed_barcode}}
            changed = await client.post(endpoint, json=changed_body, headers=headers)
            assert changed.status_code == 201, changed.text
            changed_draft_id = changed.json()["product_draft_id"]
            changed_price_id = changed.json()["price_draft_id"]
            updated = await client.put(
                f"/api/v2/products/drafts/{changed_draft_id}",
                json={"revision": 1, "data": {**item, "ean": "3073781178008"}},
                headers=headers,
            )
            assert updated.status_code == 200, updated.text
            published = await client.post(
                f"/api/v2/products/drafts/{changed_draft_id}/approve",
                json={"revision": 2}, headers={"x-test-user": "admin"},
            )
            assert published.status_code == 200, published.text
            assert (await client.post(
                f"/api/v2/prices/drafts/{changed_price_id}/approve",
                headers={"x-test-user": "admin"},
            )).status_code == 409
            assert (await client.post(
                f"/api/v2/prices/drafts/{changed_price_id}/reject",
                headers={"x-test-user": "admin"},
            )).status_code == 200
            assert await connection.fetchval("SELECT count(*) FROM v2_price_observations") == 1
    finally:
        await connection.close()
