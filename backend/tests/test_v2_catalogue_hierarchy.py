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
from app.services.v2_catalogue_hierarchy import UNCATEGORIZED, default_classification

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
            "DELETE FROM v2_schema_migrations WHERE version='0027_catalogue_hierarchy'"
        )
        for name, group, tags in (
            ("Chips nature", "Chips paysanne", ["chips"]),
            ("Chips sel", "Chips paysanne", ["chips"]),
            ("Inconnu", "Groupe nouveau", []),
        ):
            await connection.execute(
                "INSERT INTO v2_products(data) VALUES($1::jsonb)",
                json.dumps({"name": name, "brand": "Test", "group": group,
                            "tags": tags, "quantity": "100 g", "package": "sachet"}),
            )
    finally:
        await connection.close()

    assert await migrate_v2(isolated_config) == ["0027_catalogue_hierarchy"]
    assert await migrate_v2(isolated_config) == []
    connection = await connect_v2(isolated_config)
    try:
        rows = await connection.fetch(
            "SELECT group_name,department,family,source FROM "
            "v2_catalogue_classifications ORDER BY group_name"
        )
        assert [(row["group_name"], row["department"], row["family"], row["source"])
                for row in rows] == [
            ("Chips paysanne", "Épicerie salée", "Chips", "local_tag"),
            ("Groupe nouveau", UNCATEGORIZED, UNCATEGORIZED, "unclassified"),
        ]
        assert await connection.fetchval("SELECT count(*) FROM v2_products") == 3
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


def test_unknown_classification_is_explicit():
    assert default_classification("Nouveau", ["hors taxonomie"]) == (
        UNCATEGORIZED, UNCATEGORIZED, "unclassified"
    )
