"""Public price history is populated only by approved, account-scoped drafts."""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import pytest

from app.api.v2 import prices
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


@pytest.mark.asyncio
async def test_price_drafts_are_private_until_approved(monkeypatch):
    config = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    await migrate_v2(config)
    connection = await connect_v2(config)
    product_id = author_id = reviewer_id = other_id = None
    try:
        product_id = await connection.fetchval(
            "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
            '{"name":"Disposable coffee","quantity":"250 g"}',
        )
        author_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('PriceAuthor','priceauthor','test','confirmed') RETURNING id"
        )
        reviewer_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('PriceAdmin','priceadmin','test','admin') RETURNING id"
        )
        other_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('PriceOther','priceother','test','visitor') RETURNING id"
        )
        users = {
            "author": {"id": author_id, "role": "confirmed", "username": "PriceAuthor"},
            "admin": {"id": reviewer_id, "role": "admin", "username": "PriceAdmin"},
            "other": {"id": other_id, "role": "visitor", "username": "PriceOther"},
        }

        async def fake_connect():
            return await connect_v2(config)

        async def fake_user(_connection, request):
            return users.get(request.headers.get("x-test-user"))

        monkeypatch.setattr(prices, "_connect", fake_connect)
        monkeypatch.setattr(prices, "_current_user", fake_user)
        transport = httpx.ASGITransport(app=app)
        base = f"/api/v2/prices/products/{product_id}"
        observed = (datetime.now(UTC) - timedelta(days=1)).replace(microsecond=0).isoformat()
        observed_day = datetime.fromisoformat(observed).astimezone(ZoneInfo("Europe/Paris")).date().isoformat()
        payload = {
            "retailer": "Disposable Shop", "store_name": "Centre",
            "city": "Paris", "postal_code": "75001", "sales_channel": "in_store",
            "price": "2.50", "observed_at": observed, "note": "Shelf label",
        }
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            assert (await client.get(base)).json()["observations"] == []
            assert (await client.post(base + "/drafts", json=payload)).status_code == 401
            invalid = {**payload, "observed_at": "2026-10-26T02:00:00"}
            assert (await client.post(base + "/drafts", json=invalid,
                                      headers={"x-test-user": "author"})).status_code == 422
            first = await client.post(base + "/drafts", json=payload,
                                      headers={"x-test-user": "author"})
            assert first.status_code == 201, first.text
            first_id = first.json()["id"]
            second = await client.post(base + "/drafts", json={**payload, "sales_channel": "drive",
                                                             "observed_at": observed_day},
                                       headers={"x-test-user": "author"})
            assert second.status_code == 201, second.text
            second_id = second.json()["id"]
            assert (await client.get(base)).json()["observations"] == []
            assert (await client.get(base + "/drafts", headers={"x-test-user": "other"})).json() == []
            own = (await client.get(base + "/drafts", headers={"x-test-user": "author"})).json()
            assert {row["id"] for row in own} == {first_id, second_id}
            assert all(row["observed_at"] == observed_day for row in own)
            assert (await client.post(f"/api/v2/prices/drafts/{first_id}/approve",
                                      headers={"x-test-user": "other"})).status_code == 403
            for draft_id in (first_id, second_id):
                published = await client.post(f"/api/v2/prices/drafts/{draft_id}/approve",
                                              headers={"x-test-user": "admin"})
                assert published.status_code == 200, published.text
            observations = (await client.get(base)).json()["observations"]
            assert len(observations) == 2
            assert {row["sales_channel"] for row in observations} == {"in_store", "drive"}
            assert all(row["price"] == "2.50" for row in observations)
            assert all(row["observed_at"] == observed_day for row in observations)
            stored = await connection.fetch(
                "SELECT observed_at FROM v2_price_observations WHERE product_id=$1", product_id
            )
            assert len({row["observed_at"] for row in stored}) == 1
            assert all(row["retailer"] == "Disposable Shop" for row in observations)
            assert (await client.post(f"/api/v2/prices/drafts/{first_id}/approve",
                                      headers={"x-test-user": "admin"})).status_code == 404
            duplicate = await client.post(base + "/drafts", json=payload,
                                          headers={"x-test-user": "author"})
            duplicate_id = duplicate.json()["id"]
            assert (await client.post(f"/api/v2/prices/drafts/{duplicate_id}/approve",
                                      headers={"x-test-user": "admin"})).status_code == 409
            assert (await client.get(base)).json()["observations"] == observations
            assert (await client.post(f"/api/v2/prices/drafts/{duplicate_id}/reject",
                                      headers={"x-test-user": "admin"})).status_code == 200
            assert (await client.get("/api/v2/prices/products/999999999")).status_code == 404
    finally:
        if product_id is not None:
            await connection.execute(
                "DELETE FROM v2_price_observations WHERE product_id=$1", product_id
            )
            await connection.execute("DELETE FROM v2_price_drafts WHERE product_id=$1", product_id)
            await connection.execute(
                "DELETE FROM v2_stores WHERE retailer_id IN "
                "(SELECT id FROM v2_retailers WHERE name='Disposable Shop')"
            )
            await connection.execute("DELETE FROM v2_retailers WHERE name='Disposable Shop'")
            await connection.execute("DELETE FROM v2_products WHERE id=$1", product_id)
        for user_id in (author_id, reviewer_id, other_id):
            if user_id is not None:
                await connection.execute("DELETE FROM v2_users WHERE id=$1", user_id)
        await connection.close()
