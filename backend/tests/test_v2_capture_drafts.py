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
            assert observations[0]["source"] == "bookmarklet"
            assert await connection.fetchval(
                "SELECT source_url FROM v2_price_observations WHERE id=$1",
                observations[0]["id"],
            ) == body["source_url"]
            assert (await client.post(endpoint, json=body, headers=headers)).status_code == 409

            published_endpoint = f"/api/v2/prices/products/{product_id}/capture-drafts"
            mismatch = await client.post(
                published_endpoint,
                json={"ean": "12345678", "source_url": body["source_url"], "price": price},
                headers=headers,
            )
            assert mismatch.status_code == 409
            missing_postcode = await client.post(
                published_endpoint,
                json={"ean": barcode, "source_url": body["source_url"],
                      "price": {**price, "postal_code": ""}},
                headers=headers,
            )
            assert missing_postcode.status_code == 422
            published_capture = await client.post(
                published_endpoint,
                json={"ean": barcode, "source_url": body["source_url"],
                      "price": {**price, "price": "5.60"}},
                headers=headers,
            )
            assert published_capture.status_code == 201, published_capture.text
            published_capture_id = published_capture.json()["id"]
            retained = await connection.fetchrow(
                "SELECT entry_kind,captured_via,source_url,capture_ean "
                "FROM v2_price_drafts WHERE id=$1", published_capture_id,
            )
            assert dict(retained) == {
                "entry_kind": "capture", "captured_via": "bookmarklet",
                "source_url": body["source_url"], "capture_ean": barcode,
            }
            approved_capture = await client.post(
                f"/api/v2/prices/drafts/{published_capture_id}/approve",
                headers={"x-test-user": "admin"},
            )
            assert approved_capture.status_code == 200, approved_capture.text
            retained_observation = await connection.fetchrow(
                "SELECT source,source_url,capture_ean FROM v2_price_observations "
                "WHERE id=$1", approved_capture.json()["observation_id"],
            )
            assert dict(retained_observation) == {
                "source": "bookmarklet", "source_url": body["source_url"],
                "capture_ean": barcode,
            }
            # Private draft expiry/account deletion may sever this link; the
            # published provenance must remain on the observation itself.
            await connection.execute(
                "UPDATE v2_price_observations SET price_draft_id=NULL WHERE id=$1",
                approved_capture.json()["observation_id"],
            )
            await connection.execute(
                "DELETE FROM v2_price_drafts WHERE id=$1", published_capture_id,
            )
            assert dict(await connection.fetchrow(
                "SELECT source,source_url,capture_ean FROM v2_price_observations "
                "WHERE id=$1", approved_capture.json()["observation_id"],
            )) == dict(retained_observation)

            await connection.execute(
                "INSERT INTO v2_content_withdrawals(kind,content_id,reason,withdrawn_by) "
                "VALUES('product',$1,'Test retrait',$2)", product_id, users["admin"]["id"],
            )
            republished = await client.post(endpoint, json=body, headers=headers)
            assert republished.status_code == 201, republished.text
            republished_draft_id = republished.json()["product_draft_id"]
            republished_product = await client.post(
                f"/api/v2/products/drafts/{republished_draft_id}/approve",
                json={"revision": 1}, headers={"x-test-user": "admin"},
            )
            assert republished_product.status_code == 200, republished_product.text
            assert republished_product.json()["id"] != product_id
            assert (await client.get(lookup, headers=headers)).json() == {
                "kind": "product", "id": republished_product.json()["id"],
            }
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_content_withdrawals "
                "WHERE kind='product' AND content_id=$1", product_id,
            ) == 1

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
            assert await connection.fetchval("SELECT count(*) FROM v2_price_observations") == 2

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
            assert await connection.fetchval("SELECT count(*) FROM v2_price_observations") == 2
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_capture_and_approval_do_not_deadlock(monkeypatch, isolated_config):
    """Approval holding a draft row must not wait behind capture's GTIN lock."""
    import asyncio

    config = isolated_config
    connection = await connect_v2(config)
    try:
        users = {}
        for key, role in (("author", "confirmed"), ("admin", "admin")):
            identifier = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES($1,$1,'test',$2) RETURNING id", "race_" + key, role,
            )
            users[key] = {"id": identifier, "role": role}
        approval_locked = asyncio.Event()
        capture_waiting = asyncio.Event()
        intercept = False

        class ConnectionProxy:
            def __init__(self, inner):
                self.inner = inner
                self.role = ""

            def __getattr__(self, name):
                return getattr(self.inner, name)

            async def fetchrow(self, query, *args):
                if intercept and "FROM v2_product_drafts" in query and "FOR UPDATE" in query:
                    if self.role == "admin" and query.startswith("SELECT *"):
                        result = await self.inner.fetchrow(query, *args)
                        approval_locked.set()
                        await asyncio.wait_for(capture_waiting.wait(), 3)
                        return result
                    if self.role == "confirmed":
                        capture_waiting.set()
                return await self.inner.fetchrow(query, *args)

        async def fake_connect():
            return ConnectionProxy(await connect_v2(config))

        async def fake_user(proxy, request):
            user = users.get(request.headers.get("x-test-user"))
            if user:
                proxy.role = user["role"]
            return user

        for module in (prices, products):
            monkeypatch.setattr(module, "_connect", fake_connect)
            monkeypatch.setattr(module, "_current_user", fake_user)

        barcode = "3073781178021"
        day = datetime.now(ZoneInfo("Europe/Paris")).date().isoformat()
        body = {
            "ean": barcode, "source_url": "https://example.org/race",
            "product_data": {"ean": barcode, "name": "Produit concurrent",
                             "brand": "Test", "package": "sachet", "quantity": "250 g"},
            "price": {"retailer": "Race Shop", "store_name": "Centre",
                      "city": "Paris", "postal_code": "75001",
                      "sales_channel": "in_store", "price": "3.20", "observed_at": day},
        }
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://test"
        ) as client:
            created = await client.post(
                "/api/v2/prices/capture-drafts", json=body, headers={"x-test-user": "author"},
            )
            assert created.status_code == 201, created.text
            draft_id = created.json()["product_draft_id"]
            intercept = True
            approve = asyncio.create_task(client.post(
                f"/api/v2/products/drafts/{draft_id}/approve",
                json={"revision": 1}, headers={"x-test-user": "admin"},
            ))
            await asyncio.wait_for(approval_locked.wait(), 3)
            attach = asyncio.create_task(client.post(
                "/api/v2/prices/capture-drafts",
                json={"ean": barcode, "product_draft_id": draft_id,
                      "source_url": body["source_url"], "price": body["price"]},
                headers={"x-test-user": "author"},
            ))
            approved, attached = await asyncio.wait_for(
                asyncio.gather(approve, attach), 5,
            )
            assert approved.status_code == 200, approved.text
            assert attached.status_code in (404, 409), attached.text
    finally:
        await connection.close()
