"""Portable public catalogue/prices, atomic conflicts and idempotent re-import."""

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from app.api.v2 import transfers
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app
from fastapi import HTTPException

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


@pytest.mark.asyncio
async def test_export_import_between_two_disposable_instances(monkeypatch):
    admin_config = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    suffix = uuid4().hex[:10]
    source_name, target_name = f"transfer_src_{suffix}", f"transfer_dst_{suffix}"
    admin = await connect_v2(admin_config)
    await admin.execute(f'CREATE DATABASE "{source_name}"')
    await admin.execute(f'CREATE DATABASE "{target_name}"')
    source_config = {**admin_config, "database": source_name}
    target_config = {**admin_config, "database": target_name}
    try:
        await migrate_v2(source_config)
        await migrate_v2(target_config)
        source = await connect_v2(source_config)
        try:
            old = await source.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
                json.dumps({"name": "Sample coffee old", "brand": "Sample", "package": "Bag",
                            "quantity": "400 g", "ean": "3017620422003"}),
            )
            current = await source.fetchval(
                "INSERT INTO v2_products(data,predecessor_id) VALUES($1::jsonb,$2) RETURNING id",
                json.dumps({"name": "Sample coffee", "brand": "Sample", "package": "Bag",
                            "quantity": "400 g", "ean": "3017620422003"}), old,
            )
            retailer = await source.fetchval(
                "INSERT INTO v2_retailers(code,name) VALUES('sample','Sample Market') RETURNING id"
            )
            store = await source.fetchval(
                "INSERT INTO v2_stores(retailer_id,name,city,postal_code) "
                "VALUES($1,'Centre','Paris','75001') RETURNING id", retailer,
            )
            for channel in ("in_store", "drive"):
                await source.execute(
                    "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,source,"
                    "price,observed_at,note,sales_channel) "
                    "VALUES($1,$2,$3,'manual',2.50,$4,'Shelf label',$5)",
                    current, retailer, store, datetime.now(UTC), channel,
                )
        finally:
            await source.close()

        active = source_config

        async def fake_connect():
            return await connect_v2(active)

        async def fake_admin(request):
            if request.headers.get("x-test-admin") != "yes":
                raise HTTPException(status_code=403, detail="Accès administrateur requis.")

        monkeypatch.setattr(transfers, "_connect", fake_connect)
        monkeypatch.setattr(transfers, "_require_admin", fake_admin)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            assert (await client.get("/api/v2/transfers/export")).status_code == 403
            exported = await client.get("/api/v2/transfers/export", headers={"x-test-admin": "yes"})
            assert exported.status_code == 200, exported.text
            archive = exported.json()
            assert set(archive) == {"format", "schema_version", "source_instance", "products",
                                    "retailers", "stores", "prices"}
            assert len(archive["products"]) == 2
            assert len(archive["prices"]) == 2
            assert all(len(item["observed_at"]) == 10 for item in archive["prices"])
            assert {item["sales_channel"] for item in archive["prices"]} == {"in_store", "drive"}
            assert (await client.post("/api/v2/transfers/import", json=archive)).status_code == 403
            assert (await client.post("/api/v2/transfers/import", json=archive,
                                      headers={"x-test-admin": "yes"})).status_code == 409
            active = target_config
            target = await connect_v2(target_config)
            collision = await target.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
                json.dumps({"name": "Unrelated", "ean": "3017620422003"}),
            )
            await target.close()
            refused = await client.post("/api/v2/transfers/import", json=archive,
                                        headers={"x-test-admin": "yes"})
            assert refused.status_code == 409, refused.text
            target = await connect_v2(target_config)
            assert await target.fetchval("SELECT count(*) FROM v2_products") == 1
            assert await target.fetchval("SELECT count(*) FROM v2_transfer_product_map") == 0
            await target.execute("DELETE FROM v2_products WHERE id=$1", collision)
            await target.close()
            imported = await client.post("/api/v2/transfers/import", json=archive,
                                         headers={"x-test-admin": "yes"})
            assert imported.status_code == 200, imported.text
            assert imported.json()["products_imported"] == 2
            assert imported.json()["prices_imported"] == 2
            repeated = await client.post("/api/v2/transfers/import", json=archive,
                                         headers={"x-test-admin": "yes"})
            assert repeated.status_code == 200, repeated.text
            assert repeated.json()["products_already_present"] == 2
            assert repeated.json()["prices_already_present"] == 2
            target = await connect_v2(target_config)
            try:
                rows = await target.fetch(
                    "SELECT p.name, o.price,o.sales_channel,o.source,o.source_provider "
                    "FROM v2_price_observations o JOIN v2_products v ON v.id=o.product_id "
                    "CROSS JOIN LATERAL (SELECT v.data->>'name' AS name) p ORDER BY o.id"
                )
                assert len(rows) == 2
                assert {row["sales_channel"] for row in rows} == {"in_store", "drive"}
                assert all(row["source"] == "third_party" and
                           row["source_provider"] == "price-checker-v2" for row in rows)
                assert all(row["name"] == "Sample coffee" for row in rows)
            finally:
                await target.close()
            changed = json.loads(json.dumps(archive))
            changed["products"][0]["data"]["name"] = "Changed at source"
            assert (await client.post("/api/v2/transfers/import", json=changed,
                                      headers={"x-test-admin": "yes"})).status_code == 409
            cycle = json.loads(json.dumps(archive))
            cycle["products"][0]["predecessor_id"] = cycle["products"][1]["id"]
            cycle["products"].append({
                "id": max(item["id"] for item in cycle["products"]) + 1,
                "predecessor_id": None,
                "data": {"name": "Independent", "brand": "Sample", "package": "Bag", "quantity": "100 g"},
            })
            refused_cycle = await client.post("/api/v2/transfers/import", json=cycle,
                                              headers={"x-test-admin": "yes"})
            assert refused_cycle.status_code == 422, refused_cycle.text
            target = await connect_v2(target_config)
            try:
                assert await target.fetchval("SELECT count(*) FROM v2_products") == 2
                assert await target.fetchval("SELECT count(*) FROM v2_transfer_product_map") == 2
            finally:
                await target.close()
            broken = json.loads(json.dumps(archive))
            broken["stores"] = []
            assert (await client.post("/api/v2/transfers/import", json=broken,
                                      headers={"x-test-admin": "yes"})).status_code == 422
    finally:
        await admin.execute(f'DROP DATABASE "{source_name}" WITH (FORCE)')
        await admin.execute(f'DROP DATABASE "{target_name}" WITH (FORCE)')
        await admin.close()
