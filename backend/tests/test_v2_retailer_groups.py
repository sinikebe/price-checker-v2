"""Explicit retailer families group the directory without rewriting price provenance."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

import httpx
import pytest

from app.api.v2 import stores
from app.db.v2_migrations import MIGRATIONS, connect_v2, migrate_v2
from app.main_v2 import app

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable PostgreSQL required"
)


@pytest.mark.asyncio
async def test_retailer_group_backfill_management_and_directory(monkeypatch):
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    name = "v2_retailer_groups_" + secrets.token_hex(5)
    root = await connect_v2(base)
    try:
        await root.execute('CREATE DATABASE "' + name + '"')
    finally:
        await root.close()
    config = {**base, "database": name}
    try:
        connection = await connect_v2(config)
        try:
            await connection.execute(
                "CREATE TABLE v2_schema_migrations("
                "version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())"
            )
            for version, ddl in MIGRATIONS.items():
                if version == "0024_retailer_groups":
                    break
                await connection.execute(ddl)
                await connection.execute(
                    "INSERT INTO v2_schema_migrations(version) VALUES($1)", version
                )
            labels = (
                "Auchan", "Auchan Supermarché", "Carrefour", "Carrefour City",
                "Intermarché", "Intermarché Super", "E.Leclerc", "E. Leclerc",
                "Centre Commercial E.Leclerc", "Super U", "Spar",
            )
            source_ids = {}
            for index, label in enumerate(labels):
                source_ids[label] = await connection.fetchval(
                    "INSERT INTO v2_retailers(code,name) VALUES($1,$2) RETURNING id",
                    f"source-{index}", label,
                )
            store_ids = {}
            for index, label in enumerate(("Auchan", "Auchan Supermarché", "Spar")):
                store_ids[label] = await connection.fetchval(
                    "INSERT INTO v2_stores(retailer_id,name,city,postal_code,osm_type,osm_id) "
                    "VALUES($1,$2,'Paris','75001','node',$3) RETURNING id",
                    source_ids[label], label + " Paris", 100 + index,
                )
            product_id = await connection.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
                json.dumps({"name": "Lait", "ean": "12345670"}),
            )
            observation_id = await connection.fetchval(
                "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,"
                "source,price,observed_at,sales_channel) "
                "VALUES($1,$2,$3,'manual',1.50,now(),'in_store') RETURNING id",
                product_id, source_ids["Auchan Supermarché"],
                store_ids["Auchan Supermarché"],
            )
        finally:
            await connection.close()

        assert await migrate_v2(config) == [
                "0024_retailer_groups", "0025_merge_source_retailers_and_barcode_sync",
                "0026_account_security", "0027_catalogue_hierarchy",
                "0028_catalogue_comparison_scopes", "0029_store_lifecycle",
                "0032_connector_stores", "0033_connector_rollback", "0034_connector_schema",
                "0035_search_settings", "0036_basket_credits", "0037_logs_and_stats"
            ]
        connection = await connect_v2(config)
        try:
            rows = await connection.fetch(
                "SELECT r.id,r.name,g.id AS group_id,g.name AS group_name "
                "FROM v2_retailers r JOIN v2_retailer_groups g ON g.id=r.group_id"
            )
            group = {row["name"]: row["group_id"] for row in rows}
            assert group["Auchan"] == group["Auchan Supermarché"]
            assert group["Carrefour"] == group["Carrefour City"]
            assert group["Intermarché"] == group["Intermarché Super"]
            assert group["E.Leclerc"] == group["E. Leclerc"] == group["Centre Commercial E.Leclerc"]
            assert group["Super U"] != group["Spar"]
            assert await connection.fetchval(
                "SELECT retailer_id FROM v2_price_observations WHERE id=$1",
                observation_id,
            ) == source_ids["Auchan Supermarché"]
            duplicate_source = await connection.fetchval(
                "INSERT INTO v2_retailers(code,name) VALUES('new-auchan','Auchan Supermarché') "
                "RETURNING group_id"
            )
            assert duplicate_source == group["Auchan"]
            unknown_group = await connection.fetchval(
                "INSERT INTO v2_retailers(code,name) VALUES('new-auchan-drive','Auchan Drive') "
                "RETURNING group_id"
            )
            assert unknown_group != group["Auchan"]
            admin_id = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES('admin','admin','test','admin') RETURNING id"
            )
        finally:
            await connection.close()

        async def fake_connect():
            return await connect_v2(config)

        async def fake_user(_connection, request):
            if request.headers.get("x-test-user") == "admin":
                return {"id": admin_id, "username": "admin", "role": "admin"}
            return None

        monkeypatch.setattr(stores, "_connect", fake_connect)
        monkeypatch.setattr(stores, "_current_user", fake_user)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://test"
        ) as client:
            directory = await client.get("/api/v2/stores")
            assert directory.status_code == 200, directory.text
            public = {item["id"]: item for item in directory.json()}
            assert public[store_ids["Auchan"]]["retailer_group_id"] == group["Auchan"]
            assert public[store_ids["Auchan Supermarché"]]["retailer_group_id"] == group["Auchan"]
            assert public[store_ids["Auchan Supermarché"]]["retailer"] == "Auchan Supermarché"
            assert (await client.get("/api/v2/stores/retailer-groups")).status_code == 403
            denied = await client.put(
                f"/api/v2/stores/retailers/{source_ids['Spar']}/group",
                json={"group_id": group["Super U"]},
            )
            assert denied.status_code == 403
            groups = await client.get(
                "/api/v2/stores/retailer-groups", headers={"x-test-user": "admin"}
            )
            assert groups.status_code == 200, groups.text
            assert any(item["name"] == "Auchan" for item in groups.json())
            moved = await client.put(
                f"/api/v2/stores/retailers/{source_ids['Spar']}/group",
                json={"group_id": group["Super U"]},
                headers={"x-test-user": "admin"},
            )
            assert moved.status_code == 200, moved.text
            regrouped = {item["id"]: item for item in (await client.get("/api/v2/stores")).json()}
            assert regrouped[store_ids["Spar"]]["retailer_group_id"] == group["Super U"]
            created = await client.post(
                "/api/v2/stores/retailer-groups", json={"name": "Nouveau groupe"},
                headers={"x-test-user": "admin"},
            )
            assert created.status_code == 201, created.text
            separate = await client.put(
                f"/api/v2/stores/retailers/{source_ids['Auchan Supermarché']}/group",
                json={"group_id": created.json()["id"]},
                headers={"x-test-user": "admin"},
            )
            assert separate.status_code == 200, separate.text
            assert (await client.post(
                "/api/v2/stores/retailer-groups", json={"name": "nouveau groupe"},
                headers={"x-test-user": "admin"},
            )).status_code == 409

        connection = await connect_v2(config)
        try:
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_retailer_group_events WHERE retailer_id=$1",
                source_ids["Spar"],
            ) == 1
            assert await connection.fetchval(
                "SELECT retailer_id FROM v2_price_observations WHERE id=$1",
                observation_id,
            ) == source_ids["Auchan Supermarché"]
            moved_variants = await connection.fetch(
                "SELECT group_id FROM v2_retailers WHERE name='Auchan Supermarché'"
            )
            assert len(moved_variants) == 2
            assert {row["group_id"] for row in moved_variants} == {created.json()["id"]}
            future_variant_group = await connection.fetchval(
                "INSERT INTO v2_retailers(code,name) VALUES('later-auchan','Auchan Supermarché') "
                "RETURNING group_id"
            )
            assert future_variant_group == created.json()["id"]
        finally:
            await connection.close()
    finally:
        root = await connect_v2(base)
        try:
            await root.execute('DROP DATABASE "' + name + '" WITH (FORCE)')
        finally:
            await root.close()
