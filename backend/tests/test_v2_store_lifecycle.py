"""Inactive stores stay recoverable; deletion removes price provenance."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

import httpx
import pytest

from app.api.v2 import catalogue, prices, stores
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app
from app.services.v2_open_prices_sync import _store as open_prices_store

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable PostgreSQL required"
)


@pytest.mark.asyncio
async def test_deactivate_reactivate_and_permanently_delete_store(monkeypatch):
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    name = "v2_store_lifecycle_" + secrets.token_hex(5)
    root = await connect_v2(base)
    try:
        await root.execute('CREATE DATABASE "' + name + '"')
    finally:
        await root.close()
    config = {**base, "database": name}
    try:
        await migrate_v2(config)
        connection = await connect_v2(config)
        try:
            admin_id = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES('admin','admin','test','admin') RETURNING id"
            )
            retailer_id = await connection.fetchval(
                "INSERT INTO v2_retailers(code,name) VALUES('retailer','Exemple') RETURNING id"
            )
            target_id = await connection.fetchval(
                "INSERT INTO v2_stores(retailer_id,name,city,postal_code,osm_type,osm_id,import_key) "
                "VALUES($1,'Exemple fermé','Paris','75001','node',12345,"
                "'open_prices:location:67890') RETURNING id", retailer_id,
            )
            other_id = await connection.fetchval(
                "INSERT INTO v2_stores(retailer_id,name,city,postal_code,osm_type,osm_id) "
                "VALUES($1,'Exemple ouvert','Paris','75002','node',12346) RETURNING id",
                retailer_id,
            )
            donor_id = await connection.fetchval(
                "INSERT INTO v2_stores(retailer_id,name,city,postal_code,import_key) "
                "VALUES($1,'Ancien nom','Paris','75001','open_prices:location:77777') "
                "RETURNING id", retailer_id,
            )
            await connection.execute(
                "INSERT INTO v2_content_merges(kind,from_id,to_id,from_snapshot,to_snapshot,result_snapshot) "
                "VALUES('store',$1,$2,'{}','{}','{}')", donor_id, target_id,
            )
            product_id = await connection.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
                json.dumps({"name": "Produit", "brand": "Test", "group": "Lait"}),
            )
            for store_id in (target_id, other_id):
                await connection.execute(
                    "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,"
                    "source,price,observed_at,sales_channel) "
                    "VALUES($1,$2,$3,'manual',1.50,now(),'in_store')",
                    product_id, retailer_id, store_id,
                )
            await connection.execute(
                "INSERT INTO v2_price_drafts(author_id,product_id,retailer_id,store_id,"
                "entry_kind,price,observed_at) VALUES($1,$2,$3,$4,'manual',1.60,now())",
                admin_id, product_id, retailer_id, target_id,
            )
            offer_id = await connection.fetchval(
                "INSERT INTO v2_offers(retailer_id,store_id,source_kind,channel,title,"
                "price_amount,collected_at) VALUES($1,$2,'connector','in_store','Produit',1.50,now()) "
                "RETURNING id", retailer_id, target_id,
            )
            await connection.execute(
                "INSERT INTO v2_offer_product_links(offer_id,product_id,link_type) "
                "VALUES($1,$2,'manual')", offer_id, product_id,
            )
            await connection.execute(
                "INSERT INTO v2_store_osm_aliases(osm_type,osm_id,store_id) "
                "VALUES('way',54321,$1)", donor_id,
            )
        finally:
            await connection.close()

        async def fake_connect():
            return await connect_v2(config)

        async def fake_user(_connection, request):
            if request.headers.get("x-test-user") == "admin":
                return {"id": admin_id, "username": "admin", "role": "admin"}
            return None

        for module in (stores, prices, catalogue):
            monkeypatch.setattr(module, "_connect", fake_connect)
        monkeypatch.setattr(stores, "_current_user", fake_user)
        admin = {"x-test-user": "admin"}
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://test"
        ) as client:
            path = f"/api/v2/stores/{target_id}"
            assert (await client.put(path + "/activity", json={"active": False})).status_code == 403
            disabled = await client.put(path + "/activity", json={"active": False}, headers=admin)
            assert disabled.status_code == 200, disabled.text
            assert (await client.get(path)).status_code == 404
            assert (await client.get(f"/api/v2/stores/{donor_id}")).status_code == 404
            assert (await client.get(path, headers=admin)).json()["active"] is False
            assert target_id not in {row["id"] for row in (await client.get("/api/v2/stores")).json()}
            assert target_id in {row["id"] for row in (await client.get("/api/v2/stores", headers=admin)).json()}
            history = (await client.get(f"/api/v2/prices/products/{product_id}")).json()
            assert {row["store_id"] for row in history["latest_by_store"]} == {other_id}
            assert (await client.get("/api/v2/catalogue/stores?q=Exemple")).json() == [
                {"id": other_id, "retailer": "Exemple", "name": "Exemple ouvert",
                 "city": "Paris", "postal_code": "75002"}
            ]
            connection = await connect_v2(config)
            try:
                with pytest.raises(Exception) as exc:
                    await stores.visible_store(connection, target_id, {"id": admin_id, "role": "admin"})
                assert getattr(exc.value, "status_code", None) == 404
                assert await open_prices_store(connection, {
                    "osm_type": "NODE", "osm_id": 12345, "id": 67890,
                    "osm_name": "Exemple fermé", "osm_brand": "Exemple",
                    "osm_address_city": "Paris", "osm_address_postcode": "75001",
                }) is None
            finally:
                await connection.close()
            assert (await client.put(path + "/activity", json={"active": True}, headers=admin)).status_code == 200
            history = (await client.get(f"/api/v2/prices/products/{product_id}")).json()
            assert {row["store_id"] for row in history["latest_by_store"]} == {target_id, other_id}
            assert (await client.post(path + "/delete", json={"confirmation": "faux"}, headers=admin)).status_code == 422
            assert (await client.post(path + "/delete", json={"confirmation": "Exemple fermé"})).status_code == 403
            deleted = await client.post(path + "/delete", json={"confirmation": "Exemple fermé"}, headers=admin)
            assert deleted.status_code == 200, deleted.text
            assert deleted.json()["deleted_prices"] == 1
            assert set(deleted.json()["deleted_store_ids"]) == {target_id, donor_id}
            assert (await client.get(path, headers=admin)).status_code == 404
            history = (await client.get(f"/api/v2/prices/products/{product_id}")).json()
            assert {row["store_id"] for row in history["latest_by_store"]} == {other_id}
            connection = await connect_v2(config)
            try:
                for table in ("v2_price_observations", "v2_price_drafts", "v2_offers"):
                    assert await connection.fetchval(
                        f"SELECT count(*) FROM {table} WHERE store_id=$1", target_id,
                    ) == 0
                assert await connection.fetchval(
                    "SELECT count(*) FROM v2_offer_product_links WHERE offer_id=$1", offer_id,
                ) == 0
                assert await open_prices_store(connection, {
                    "osm_type": "NODE", "osm_id": 12345, "id": 67890,
                    "osm_name": "Exemple fermé", "osm_brand": "Exemple",
                    "osm_address_city": "Paris", "osm_address_postcode": "75001",
                }) is None
                assert await connection.fetchval(
                    "SELECT count(*) FROM v2_deleted_store_sources WHERE source_key=$1",
                    "osm:way:54321",
                ) == 1
            finally:
                await connection.close()
    finally:
        root = await connect_v2(base)
        try:
            await root.execute('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)')
        finally:
            await root.close()
