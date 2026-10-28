"""Portable public catalogue/prices, atomic conflicts and idempotent re-import."""

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

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
                    "source_url,capture_ean,price,observed_at,note,sales_channel) "
                    "VALUES($1,$2,$3,$4,$5,$6,2.50,$7,'Shelf label',$8)",
                    current, retailer, store,
                    "bookmarklet" if channel == "drive" else "manual",
                    "https://example.org/captured" if channel == "drive" else None,
                    "3017620422003" if channel == "drive" else None,
                    datetime.now(UTC), channel,
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
                    "SELECT p.name, o.price,o.sales_channel,o.source,o.source_provider,"
                    "o.source_url,o.capture_ean "
                    "FROM v2_price_observations o JOIN v2_products v ON v.id=o.product_id "
                    "CROSS JOIN LATERAL (SELECT v.data->>'name' AS name) p ORDER BY o.id"
                )
                assert len(rows) == 2
                assert {row["sales_channel"] for row in rows} == {"in_store", "drive"}
                assert all(row["source"] == "third_party" for row in rows)
                by_channel = {row["sales_channel"]: row for row in rows}
                assert by_channel["in_store"]["source_provider"] == "price-checker-v2"
                assert by_channel["drive"]["source_provider"] == "price-checker-v2/bookmarklet"
                assert by_channel["drive"]["source_url"] == "https://example.org/captured"
                assert by_channel["drive"]["capture_ean"] == "3017620422003"
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


@pytest.mark.asyncio
async def test_identical_product_adoption_preserves_visibility_and_idempotence(monkeypatch):
    admin_config = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = f"transfer_adopt_{uuid4().hex[:10]}"
    admin = await connect_v2(admin_config)
    await admin.execute(f'CREATE DATABASE "{database}"')
    config = {**admin_config, "database": database}
    try:
        await migrate_v2(config)
        target = await connect_v2(config)
        product_data = {
            "name": "Sample tea", "brand": "Sample", "package": "Box",
            "quantity": "20 bags", "ean": "3017620422003",
        }
        hidden_data = {**product_data, "ean": "3017620422004"}
        try:
            old = await target.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
                json.dumps({**product_data, "name": "Old tea"}),
            )
            existing = await target.fetchval(
                "INSERT INTO v2_products(data,predecessor_id) "
                "VALUES($1::jsonb,$2) RETURNING id",
                json.dumps(product_data), old,
            )
            withdrawn = await target.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
                json.dumps(hidden_data),
            )
            moderator = await target.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES('moderator','moderator','unused','admin') RETURNING id"
            )
            await target.execute(
                "INSERT INTO v2_content_withdrawals(kind,content_id,reason,withdrawn_by) "
                "VALUES('product',$1,'test',$2)", withdrawn, moderator,
            )
        finally:
            await target.close()

        async def fake_connect():
            return await connect_v2(config)

        async def fake_admin(request):
            if request.headers.get("x-test-admin") != "yes":
                raise HTTPException(status_code=403)

        monkeypatch.setattr(transfers, "_connect", fake_connect)
        monkeypatch.setattr(transfers, "_require_admin", fake_admin)
        bundle = {
            "format": "price-checker-v2-transfer", "schema_version": 1,
            "source_instance": str(uuid4()),
            "products": [{"id": 101, "predecessor_id": None, "data": product_data}],
            "retailers": [{"id": 201, "name": "Sample Market"}],
            "stores": [{"id": 301, "retailer_id": 201, "name": "Centre"}],
            "prices": [{"id": 401, "product_id": 101, "store_id": 301,
                        "source": "manual", "price": "2.50",
                        "observed_at": "2026-10-27"}],
        }
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            first = await client.post("/api/v2/transfers/import", json=bundle,
                                      headers={"x-test-admin": "yes"})
            assert first.status_code == 200, first.text
            assert first.json() == {
                "products_imported": 0, "prices_imported": 1,
                "products_already_present": 1, "prices_already_present": 0,
            }
            again = await client.post("/api/v2/transfers/import", json=bundle,
                                      headers={"x-test-admin": "yes"})
            assert again.status_code == 200, again.text
            assert again.json()["products_already_present"] == 1
            assert again.json()["prices_already_present"] == 1
            target = await connect_v2(config)
            try:
                assert await target.fetchval(
                    "SELECT target_id FROM v2_transfer_product_map "
                    "WHERE source_instance=$1 AND source_id=101",
                    UUID(bundle["source_instance"]),
                ) == existing
                assert await target.fetchval(
                    "SELECT product_id FROM v2_price_observations WHERE import_key IS NOT NULL"
                ) == existing
                assert await target.fetchval("SELECT count(*) FROM v2_products") == 3
            finally:
                await target.close()

            hidden_bundle = json.loads(json.dumps(bundle))
            hidden_bundle["source_instance"] = str(uuid4())
            hidden_bundle["products"][0]["data"] = hidden_data
            refused = await client.post("/api/v2/transfers/import", json=hidden_bundle,
                                        headers={"x-test-admin": "yes"})
            assert refused.status_code == 409, refused.text
            target = await connect_v2(config)
            try:
                assert await target.fetchval("SELECT count(*) FROM v2_transfer_product_map") == 1
                assert await target.fetchval("SELECT count(*) FROM v2_price_observations") == 1
            finally:
                await target.close()
    finally:
        await admin.execute(f'DROP DATABASE "{database}" WITH (FORCE)')
        await admin.close()



def test_transfer_accepts_already_published_incomplete_product():
    bundle = transfers.TransferBundle.model_validate({
        "format": "price-checker-v2-transfer", "schema_version": 1,
        "source_instance": str(uuid4()),
        "products": [{"id": 1, "data": {"name": "Produit historique"}}],
        "retailers": [], "stores": [], "prices": [],
    })
    products, _, _, _ = transfers._validate_import_bundle(bundle)
    assert products[1].data.name == "Produit historique"
    assert products[1].data.brand == ""
