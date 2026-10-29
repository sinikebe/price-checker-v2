"""API-submitted price drafts reach the author's and moderator's global inboxes."""

from __future__ import annotations

import json
import os
import secrets
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

from app.api.v2 import prices
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


@pytest_asyncio.fixture
async def isolated_db():
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_price_inbox_" + secrets.token_hex(5)
    root = await connect_v2(base)
    try:
        await root.execute('CREATE DATABASE "' + database + '"')
    finally:
        await root.close()
    config = {**base, "database": database}
    try:
        await migrate_v2(config)
        yield config
    finally:
        root = await connect_v2(base)
        try:
            await root.execute('DROP DATABASE "' + database + '" WITH (FORCE)')
        finally:
            await root.close()


@pytest.mark.asyncio
async def test_api_price_drafts_reach_private_and_admin_inboxes(monkeypatch, isolated_db):
    connection = await connect_v2(isolated_db)
    try:
        product_id = await connection.fetchval(
            "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
            json.dumps({"name": "Test rice", "brand": "CI", "package": "bag", "quantity": "1 kg"}),
        )
        users = {}
        for name, role in (("author", "confirmed"), ("other", "visitor"), ("admin", "admin")):
            user_id = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES($1,$1,'test',$2) RETURNING id", "inbox_" + name, role,
            )
            users[name] = {"id": user_id, "role": role}

        async def fake_connect():
            return await connect_v2(isolated_db)

        async def fake_user(_connection, request):
            return users.get(request.headers.get("x-test-user"))

        monkeypatch.setattr(prices, "_connect", fake_connect)
        monkeypatch.setattr(prices, "_current_user", fake_user)
        payload = {"retailer": "CI Shop", "store_name": "Centre", "city": "Paris",
                   "postal_code": "75001", "price": "2.50",
                   "observed_at": datetime.now(UTC).isoformat()}
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://test",
        ) as client:
            created = await client.post(
                f"/api/v2/prices/products/{product_id}/drafts", json=payload,
                headers={"x-test-user": "author"},
            )
            assert created.status_code == 201, created.text
            assert created.json()["status"] == "draft"
            price_id = created.json()["id"]
            assert (await client.get("/api/v2/prices/drafts/mine")).status_code == 401
            assert (await client.get("/api/v2/prices/drafts/review", headers={
                "x-test-user": "author",
            })).status_code == 403
            assert (await client.get("/api/v2/prices/drafts/mine", headers={
                "x-test-user": "other",
            })).json()["items"] == []
            own = (await client.get("/api/v2/prices/drafts/mine", headers={
                "x-test-user": "author",
            })).json()
            assert own["total"] == 1
            assert own["items"][0]["id"] == price_id
            assert own["items"][0]["product_id"] == product_id
            assert own["items"][0]["product_name"] == "Test rice"
            review = (await client.get("/api/v2/prices/drafts/review", headers={
                "x-test-user": "admin",
            })).json()
            assert review["total"] == 1
            assert review["items"][0]["id"] == price_id
            published = await client.post(
                f"/api/v2/prices/drafts/{price_id}/approve", headers={"x-test-user": "admin"},
            )
            assert published.status_code == 200, published.text
            assert (await client.get("/api/v2/prices/drafts/review", headers={
                "x-test-user": "admin",
            })).json()["total"] == 0
            assert (await client.get("/api/v2/prices/drafts/mine", headers={
                "x-test-user": "author",
            })).json()["total"] == 0
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_linked_product_draft_and_inactive_store_remain_reviewable(monkeypatch, isolated_db):
    connection = await connect_v2(isolated_db)
    try:
        author_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('linked_author','linked_author','test','confirmed') RETURNING id"
        )
        admin_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('linked_admin','linked_admin','test','admin') RETURNING id"
        )
        product_draft_id = await connection.fetchval(
            "INSERT INTO v2_product_drafts(author_id,data) VALUES($1,$2::jsonb) RETURNING id",
            author_id, json.dumps({"name": "Private cereal", "brand": "CI"}),
        )
        retailer_id = await connection.fetchval(
            "INSERT INTO v2_retailers(code,name) VALUES('linked-ci','CI Shop') RETURNING id"
        )
        store_id = await connection.fetchval(
            "INSERT INTO v2_stores(retailer_id,name,active) "
            "VALUES($1,'Closed store',false) RETURNING id", retailer_id,
        )
        price_id = await connection.fetchval(
            "INSERT INTO v2_price_drafts(author_id,product_draft_id,retailer_id,store_id,"
            "entry_kind,price,observed_at,sales_channel) "
            "VALUES($1,$2,$3,$4,'manual',2.75,now(),'in_store') RETURNING id",
            author_id, product_draft_id, retailer_id, store_id,
        )

        async def fake_connect():
            return await connect_v2(isolated_db)

        async def fake_user(_connection, request):
            if request.headers.get("x-test-user") == "admin":
                return {"id": admin_id, "role": "admin"}
            return {"id": author_id, "role": "confirmed"}

        monkeypatch.setattr(prices, "_connect", fake_connect)
        monkeypatch.setattr(prices, "_current_user", fake_user)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://test",
        ) as client:
            own = (await client.get("/api/v2/prices/drafts/mine")).json()
            assert own["items"][0]["product_draft_id"] == product_draft_id
            assert own["items"][0]["product_id"] is None
            assert own["items"][0]["product_name"] == "Private cereal"
            review = (await client.get("/api/v2/prices/drafts/review", headers={
                "x-test-user": "admin",
            })).json()
            assert review["total"] == 1
            assert review["items"][0]["store_active"] is False
            assert (await client.post(
                f"/api/v2/prices/drafts/{price_id}/approve",
                headers={"x-test-user": "admin"},
            )).status_code == 409
            rejected = await client.post(
                f"/api/v2/prices/drafts/{price_id}/reject",
                headers={"x-test-user": "admin"},
            )
            assert rejected.status_code == 200, rejected.text
            assert (await client.get("/api/v2/prices/drafts/review", headers={
                "x-test-user": "admin",
            })).json()["total"] == 0
            assert (await client.get("/api/v2/prices/drafts/mine")).json()["items"][0]["status"] == "rejected"
    finally:
        await connection.close()
