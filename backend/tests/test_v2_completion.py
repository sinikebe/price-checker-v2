"""Public completeness report excludes private drafts and separates priorities."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

import httpx
import pytest
from app.api.v2 import catalogue, stores
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


@pytest.mark.asyncio
async def test_public_completion_and_admin_store_repair(monkeypatch):
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_complete_" + secrets.token_hex(5)
    admin = await connect_v2(base)
    try:
        await admin.execute('CREATE DATABASE "' + database + '"')
    finally:
        await admin.close()
    config = {**base, "database": database}
    try:
        await migrate_v2(config)
        connection = await connect_v2(config)
        try:
            admin_id = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES('complete_admin','complete_admin','test','admin') RETURNING id"
            )
            old_product = await connection.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
                json.dumps({"name": "Produit historique", "brand": "",
                            "package": "", "quantity": "200 g"}),
            )
            good_product = await connection.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
                json.dumps({"name": "Produit actuel", "brand": "Test",
                            "package": "sachet", "quantity": "200 g"}),
            )
            retailer_id = await connection.fetchval(
                "INSERT INTO v2_retailers(code,name) "
                "VALUES('complete-test','Magasin test') RETURNING id"
            )
            public_store = await connection.fetchval(
                "INSERT INTO v2_stores(retailer_id,name,city) "
                "VALUES($1,'Centre','Paris') RETURNING id", retailer_id,
            )
            private_store = await connection.fetchval(
                "INSERT INTO v2_stores(retailer_id,name) "
                "VALUES($1,'Privé') RETURNING id", retailer_id,
            )
            await connection.execute(
                "INSERT INTO v2_price_observations("
                "product_id,retailer_id,store_id,source,price,observed_at) "
                "VALUES($1,$2,$3,'manual',2.50,now())",
                good_product, retailer_id, public_store,
            )

            async def fake_connect():
                return await connect_v2(config)

            async def fake_user(_connection, request):
                if request.headers.get("x-test-user") == "admin":
                    return {"id": admin_id, "role": "admin"}
                return None

            monkeypatch.setattr(catalogue, "_connect", fake_connect)
            monkeypatch.setattr(stores, "_connect", fake_connect)
            monkeypatch.setattr(stores, "_current_user", fake_user)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="https://test"
            ) as client:
                url = "/api/v2/catalogue/to-complete"
                required = (await client.get(url)).json()
                assert {(item["kind"], item["id"]) for item in required["items"]} == {
                    ("product", old_product), ("store", public_store),
                }
                assert required["required_total"] == 2
                assert ("store", private_store) not in {
                    (item["kind"], item["id"]) for item in required["items"]
                }
                optional = (await client.get(url, params={"priority": "optional"})).json()
                assert [item["id"] for item in optional["items"]] == [good_product]
                assert optional["items"][0]["missing"] == ["code-barres", "composition"]
                assert (await client.get(url, params={"priority": "other"})).status_code == 422
                assert (await client.get(url, params={"limit": 1, "offset": 1})).json()["total"] == 2

                matches_url = "/api/v2/stores/matches"
                params = {"retailer": "Magasin test", "name": "Centre",
                          "city": "Paris", "postal_code": "75001"}
                assert (await client.get(matches_url, params=params)).json()["exact_store_id"] is None
                assert (await client.put(
                    f"/api/v2/stores/{public_store}/completion",
                    json={"city": "Paris", "postal_code": "75001"},
                )).status_code == 403
                assert (await client.put(
                    f"/api/v2/stores/{public_store}/completion",
                    json={"city": "Paris", "postal_code": ""},
                    headers={"x-test-user": "admin"},
                )).status_code == 422
                saved = await client.put(
                    f"/api/v2/stores/{public_store}/completion",
                    json={"city": "Paris", "postal_code": "75001"},
                    headers={"x-test-user": "admin"},
                )
                assert saved.status_code == 200, saved.text
                assert (await client.get(matches_url, params=params)).json()["exact_store_id"] == public_store
                after = (await client.get(url)).json()
                assert {(item["kind"], item["id"]) for item in after["items"]} == {
                    ("product", old_product),
                }
        finally:
            await connection.close()
    finally:
        admin = await connect_v2(base)
        try:
            await admin.execute('DROP DATABASE "' + database + '" WITH (FORCE)')
        finally:
            await admin.close()
