"""Online platforms: a store without an address, sold for delivery, kept by every location filter."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from app.api.v2 import catalogue, prices, stores
from app.db.v2_migrations import connect_v2
from app.main_v2 import app
from conftest import disposable_database, requires_v2_db

pytestmark = requires_v2_db
RETAILER = "Disposable Online Market"


@pytest.mark.asyncio
async def test_online_platform_prices_and_admin_marking(monkeypatch):
    async with disposable_database("v2_online_stores_") as config:
        connection = await connect_v2(config)
        product_id = author_id = admin_id = shop_id = None
        try:
            product_id = await connection.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
                '{"name":"Disposable online tea","quantity":"100 g"}',
            )
            author_id = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES('OnlineAuthor','onlineauthor','test','confirmed') RETURNING id"
            )
            admin_id = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES('OnlineAdmin','onlineadmin','test','admin') RETURNING id"
            )
            users = {
                "author": {"id": author_id, "role": "confirmed", "username": "OnlineAuthor"},
                "admin": {"id": admin_id, "role": "admin", "username": "OnlineAdmin"},
            }

            async def fake_connect():
                return await connect_v2(config)

            async def fake_user(_connection, request):
                return users.get(request.headers.get("x-test-user"))

            for module in (prices, stores, catalogue):
                monkeypatch.setattr(module, "_connect", fake_connect)
            monkeypatch.setattr(prices, "_current_user", fake_user)
            monkeypatch.setattr(stores, "_current_user", fake_user)
            author, admin = {"x-test-user": "author"}, {"x-test-user": "admin"}
            observed = (datetime.now(UTC) - timedelta(days=1)).replace(microsecond=0).isoformat()
            base = f"/api/v2/prices/products/{product_id}"
            online = {"retailer": RETAILER, "store_name": "Market.example", "city": "", "postal_code": "",
                      "online": True, "sales_channel": "delivery", "price": "3.20", "observed_at": observed}
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test") as client:
                # An online platform has no address and sells for delivery only.
                for wrong in ({"city": "Paris"}, {"postal_code": "75001"}, {"sales_channel": "in_store"}):
                    response = await client.post(base + "/drafts", json={**online, **wrong}, headers=author)
                    assert response.status_code == 422, wrong
                # A shop still needs its address.
                shop = {**online, "online": False, "sales_channel": "in_store"}
                assert (await client.post(base + "/drafts", json=shop, headers=author)).status_code == 422
                created = await client.post(base + "/drafts", json=online, headers=author)
                assert created.status_code == 201, created.text
                store = await connection.fetchrow(
                    "SELECT s.id,s.online,s.city,s.postal_code,s.supports_delivery FROM v2_price_drafts d "
                    "JOIN v2_stores s ON s.id=d.store_id WHERE d.id=$1", created.json()["id"])
                assert store["online"] is True and store["supports_delivery"] is True
                assert store["city"] is None and store["postal_code"] is None
                # The same platform is found again, not created twice.
                again = await client.post(base + "/drafts", json={**online, "price": "3.10"}, headers=author)
                assert again.status_code == 201, again.text
                assert await connection.fetchval(
                    "SELECT store_id FROM v2_price_drafts WHERE id=$1", again.json()["id"]) == store["id"]
                approved = await client.post(f"/api/v2/prices/drafts/{created.json()['id']}/approve", headers=admin)
                assert approved.status_code == 200, approved.text
                history = (await client.get(base, headers=admin)).json()
                assert [(row["store_id"], row["online"]) for row in history["latest_by_store"]] == [(store["id"], True)]
                listed = {row["id"]: row for row in (await client.get("/api/v2/stores")).json()}
                assert listed[store["id"]]["online"] is True
                # Choosing the existing platform: its kind must match, and no address is asked for.
                existing = {**online, "store_id": store["id"], "price": "3.00"}
                assert (await client.post(base + "/drafts", json=existing, headers=author)).status_code == 201
                mismatch = {**existing, "online": False, "sales_channel": "delivery"}
                assert (await client.post(base + "/drafts", json=mismatch, headers=author)).status_code == 409
                # A matching search keeps the platform whatever the city typed.
                found = (await client.get("/api/v2/stores/matches", params={
                    "retailer": RETAILER, "name": "Market.example", "city": "Lyon", "postal_code": "69001"})).json()
                assert found["exact_store_id"] == store["id"]
                # Nothing to complete for a platform.
                completion = (await client.get("/api/v2/catalogue/to-complete?priority=required&limit=100")).json()
                assert all(item.get("kind") != "store" or item["id"] != store["id"] for item in completion["items"])
                assert (await client.put(f"/api/v2/stores/{store['id']}/completion", headers=admin,
                                         json={"city": "Paris", "postal_code": "75001"})).status_code == 409

                # An administrator marks an existing store as an online platform, and back.
                retailer_id = await connection.fetchval("SELECT retailer_id FROM v2_stores WHERE id=$1", store["id"])
                shop_id = await connection.fetchval(
                    "INSERT INTO v2_stores(retailer_id,name,city,postal_code,import_key) "
                    "VALUES($1,'Old listing','Paris','75001','online-test-shop') RETURNING id", retailer_id)
                path = f"/api/v2/stores/{shop_id}/online"
                assert (await client.put(path, json={"online": True})).status_code == 403
                assert (await client.put(path, json={"online": True}, headers=author)).status_code == 403
                marked = await client.put(path, json={"online": True}, headers=admin)
                assert marked.status_code == 200, marked.text
                row = await connection.fetchrow("SELECT online,supports_delivery FROM v2_stores WHERE id=$1", shop_id)
                assert row["online"] is True and row["supports_delivery"] is True
                # Its old address is not asked for any more.
                await connection.execute(
                    "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,source,price,observed_at,"
                    "sales_channel) VALUES($1,$2,$3,'manual',3.30,now(),'delivery')", product_id, retailer_id, shop_id)
                listing = {**online, "store_id": shop_id, "store_name": "Old listing"}
                response = await client.post(base + "/drafts", json=listing, headers=author)
                assert response.status_code == 201, response.text
                assert (await client.put(path, json={"online": False}, headers=admin)).status_code == 200
                assert await connection.fetchval("SELECT online FROM v2_stores WHERE id=$1", shop_id) is False
                assert (await client.put("/api/v2/stores/999999999/online", json={"online": True},
                                         headers=admin)).status_code == 404
        finally:
            if product_id is not None:
                await connection.execute("DELETE FROM v2_price_observations WHERE product_id=$1", product_id)
                await connection.execute("DELETE FROM v2_price_drafts WHERE product_id=$1", product_id)
                await connection.execute("DELETE FROM v2_products WHERE id=$1", product_id)
            await connection.execute(
                "DELETE FROM v2_stores WHERE retailer_id IN (SELECT id FROM v2_retailers WHERE name=$1)", RETAILER)
            await connection.execute("DELETE FROM v2_retailers WHERE name=$1", RETAILER)
            for user_id in (author_id, admin_id):
                if user_id is not None:
                    await connection.execute("DELETE FROM v2_users WHERE id=$1", user_id)
            await connection.close()
