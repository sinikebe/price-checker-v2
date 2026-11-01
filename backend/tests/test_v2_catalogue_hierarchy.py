"""Catalogue migration defaults and admin-only classification edits."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

from app.api.v2 import catalogue
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app
from app.services.v2_catalogue_hierarchy import UNCATEGORIZED, default_classification, default_comparison_scope

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


@pytest_asyncio.fixture
async def isolated_config():
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_catalogue_" + secrets.token_hex(5)
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
async def test_migration_prefill_and_admin_correction(monkeypatch, isolated_config):
    # Simulate an installed database just before the catalogue migration.
    connection = await connect_v2(isolated_config)
    try:
        await connection.execute("DROP TABLE v2_catalogue_classifications")
        await connection.execute(
            "DELETE FROM v2_schema_migrations WHERE version IN "
            "('0027_catalogue_hierarchy','0028_catalogue_comparison_scopes')"
        )
        for name, group, tags in (
            ("Chips nature", "Chips paysanne", ["chips"]),
            ("Chips sel", "Chips paysanne", ["chips"]),
            ("Inconnu", "Groupe nouveau", []),
            ("Orange", "Pur jus d'orange", ["jus d'orange", "pur jus"]),
            ("Avec pulpe", "Pur jus d'orange avec pulpe", ["jus d'orange", "pur jus"]),
            ("Sans pulpe", "Pur jus d'orange sans pulpe", ["jus d'orange", "pur jus"]),
        ):
            await connection.execute(
                "INSERT INTO v2_products(data) VALUES($1::jsonb)",
                json.dumps({"name": name, "brand": "Test", "group": group,
                            "tags": tags, "quantity": "100 g", "package": "sachet"}),
            )
    finally:
        await connection.close()

    assert await migrate_v2(isolated_config) == ["0027_catalogue_hierarchy", "0028_catalogue_comparison_scopes"]
    assert await migrate_v2(isolated_config) == []
    connection = await connect_v2(isolated_config)
    try:
        rows = await connection.fetch(
            "SELECT group_name,department,family,comparison_scope,source FROM "
            "v2_catalogue_classifications ORDER BY group_name"
        )
        assert [(row["group_name"], row["department"], row["family"], row["comparison_scope"], row["source"])
                for row in rows] == [
            ("Chips paysanne", "Épicerie salée", "Chips", None, "local_tag"),
            ("Groupe nouveau", UNCATEGORIZED, UNCATEGORIZED, None, "unclassified"),
            ("Pur jus d'orange", "Boissons", "Jus de fruits", "Jus d'orange", "local_tag"),
            ("Pur jus d'orange avec pulpe", "Boissons", "Jus de fruits", "Jus d'orange", "local_tag"),
            ("Pur jus d'orange sans pulpe", "Boissons", "Jus de fruits", "Jus d'orange", "local_tag"),
        ]
        assert await connection.fetchval("SELECT count(*) FROM v2_products") == 6
        retailer = await connection.fetchval(
            "INSERT INTO v2_retailers(code,name) VALUES('test','Test') RETURNING id"
        )
        store = await connection.fetchval(
            "INSERT INTO v2_stores(retailer_id,name) VALUES($1,'Test') RETURNING id", retailer,
        )
        product_rows = await connection.fetch(
            "SELECT id,data->>'group' AS group_name FROM v2_products"
        )
        for row in product_rows:
            await connection.execute(
                "INSERT INTO v2_price_observations "
                "(product_id,retailer_id,store_id,source,price,observed_at) "
                "VALUES($1,$2,$3,'manual',1.50,now())",
                row["id"], retailer, store,
            )
    finally:
        await connection.close()

    async def fake_connect():
        return await connect_v2(isolated_config)

    async def fake_user(_connection, request):
        role = request.headers.get("x-test-role")
        return {"id": 1, "role": role} if role else None

    monkeypatch.setattr(catalogue, "_connect", fake_connect)
    monkeypatch.setattr(catalogue, "_current_user", fake_user)
    endpoint = "/api/v2/catalogue/categories/Chips%20paysanne/classification"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://test"
    ) as client:
        listed = await client.get("/api/v2/catalogue/categories")
        assert listed.status_code == 200, listed.text
        chips = next(item for item in listed.json() if item["name"] == "Chips paysanne")
        assert chips["department"] == "Épicerie salée"
        assert chips["family"] == "Chips"
        assert chips["product_count"] == 2
        assert chips["comparison_scope"] is None
        scope_url = "/api/v2/catalogue/comparison?department=Boissons&family=Jus%20de%20fruits&scope=Jus%20d%27orange"
        scope = await client.get(scope_url)
        assert scope.status_code == 200, scope.text
        assert len(scope.json()["groups"]) == 3
        assert len(scope.json()["products"]) == 3
        assert len(scope.json()["observations"]) == 3
        assert (await client.get(scope_url.replace("Boissons", "Entretien"))).status_code == 404
        single = await client.get("/api/v2/catalogue/categories/Pur%20jus%20d%27orange")
        assert len(single.json()["products"]) == 1
        assert len(single.json()["observations"]) == 1
        detail = await client.get("/api/v2/catalogue/categories/Chips%20paysanne")
        assert detail.status_code == 200, detail.text
        assert detail.json()["family"] == "Chips"
        body = {"department": "Apéritifs", "family": "Chips", "base_revision": 1}
        assert (await client.put(endpoint, json=body)).status_code == 403
        assert (await client.put(endpoint, json=body,
                                 headers={"x-test-role": "visitor"})).status_code == 403
        saved = await client.put(endpoint, json=body, headers={"x-test-role": "admin"})
        assert saved.status_code == 200, saved.text
        assert saved.json()["classification_revision"] == 2
        assert saved.json()["classification_source"] == "manual"
        assert (await client.put(endpoint, json=body,
                                 headers={"x-test-role": "admin"})).status_code == 409
        assert (await client.put(
            "/api/v2/catalogue/categories/Introuvable/classification", json=body,
            headers={"x-test-role": "admin"},
        )).status_code == 404
        assert (await client.get("/api/v2/catalogue/categories")).json()[0]["department"] == "Apéritifs"
        orange_endpoint = "/api/v2/catalogue/categories/Pur%20jus%20d%27orange/classification"
        orange_body = {"department": "Boissons", "family": "Jus de fruits",
                       "comparison_scope": None, "base_revision": 1}
        assert (await client.put(orange_endpoint, json=orange_body)).status_code == 403
        removed = await client.put(orange_endpoint, json=orange_body, headers={"x-test-role": "admin"})
        assert removed.status_code == 200, removed.text
        assert removed.json()["comparison_scope"] is None
        assert len((await client.get(scope_url)).json()["products"]) == 2
        assert (await client.put(orange_endpoint, json=orange_body,
                                 headers={"x-test-role": "admin"})).status_code == 409


def test_unknown_classification_is_explicit():
    assert default_classification("Nouveau", ["hors taxonomie"]) == (
        UNCATEGORIZED, UNCATEGORIZED, "unclassified"
    )


def test_optional_scope_defaults_are_conservative():
    assert default_comparison_scope("Pur jus d'orange sans pulpe", "Jus de fruits") == "Jus d'orange"
    assert default_comparison_scope("Haricots rouges", "Légumes en conserve") is None
    assert default_comparison_scope("Gel lave-vaisselle", "Lave-vaisselle") is None


@pytest.mark.asyncio
async def test_scope_upgrade_preserves_existing_manual_locations(isolated_config):
    connection = await connect_v2(isolated_config)
    try:
        for key, name, family in (
            ("orange", "Pur jus d'orange", "Jus de fruits"),
            ("pomme", "Pur jus de pomme", "Autres jus"),
        ):
            await connection.execute(
                "INSERT INTO v2_catalogue_classifications "
                "(group_key,group_name,department,family,source) "
                "VALUES($1,$2,'Boissons',$3,'manual')", key, name, family,
            )
        await connection.execute(
            "DELETE FROM v2_schema_migrations WHERE version='0028_catalogue_comparison_scopes'"
        )
        await connection.execute(
            "ALTER TABLE v2_catalogue_classifications DROP COLUMN comparison_scope"
        )
    finally:
        await connection.close()
    assert await migrate_v2(isolated_config) == ["0028_catalogue_comparison_scopes"]
    connection = await connect_v2(isolated_config)
    try:
        rows = await connection.fetch(
            "SELECT group_key,department,family,comparison_scope,source "
            "FROM v2_catalogue_classifications ORDER BY group_key"
        )
        assert [(row["group_key"], row["department"], row["family"],
                 row["comparison_scope"], row["source"]) for row in rows] == [
            ("orange", "Boissons", "Jus de fruits", "Jus d'orange", "manual"),
            ("pomme", "Boissons", "Autres jus", None, "manual"),
        ]
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_group_names_containing_a_slash_can_be_opened_and_classified(monkeypatch, isolated_config):
    connection = await connect_v2(isolated_config)
    try:
        await connection.execute(
            "INSERT INTO v2_products(data) VALUES($1::jsonb)",
            json.dumps({"name": "Pâtes tricolores", "brand": "Test", "group": "Pâtes/riz",
                        "tags": [], "quantity": "500 g", "package": "sachet"}),
        )
    finally:
        await connection.close()

    async def fake_connect():
        return await connect_v2(isolated_config)

    async def fake_user(_connection, request):
        role = request.headers.get("x-test-role")
        return {"id": 1, "role": role} if role else None

    monkeypatch.setattr(catalogue, "_connect", fake_connect)
    monkeypatch.setattr(catalogue, "_current_user", fake_user)
    # The page sends encodeURIComponent(name), so the slash arrives as %2F and is decoded by the server.
    group = "/api/v2/catalogue/categories/P%C3%A2tes%2Friz"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test") as client:
        opened = await client.get(group)
        assert opened.status_code == 200, opened.text
        assert [item["data"]["name"] for item in opened.json()["products"]] == ["Pâtes tricolores"]
        body = {"department": "Épicerie salée", "family": "Pâtes", "base_revision": 1}
        # The classification route is reached too: it refuses by role, not with "not found".
        assert (await client.put(group + "/classification", json=body)).status_code == 403
        assert (await client.put(group + "/classification", json=body,
                                 headers={"x-test-role": "visitor"})).status_code == 403
        missing = await client.get("/api/v2/catalogue/categories/Absent%2Fgroupe")
        assert missing.status_code == 404
        assert missing.json()["detail"] == "Catégorie introuvable."
