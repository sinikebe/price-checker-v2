"""Open Food Facts stays in the browser: the server drops its copies and keeps only contributors' facts."""

from __future__ import annotations

import json

import httpx
import pytest

from app.api.v2 import products
from app.db import v2_migrations
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app
from conftest import disposable_database, requires_v2_db

pytestmark = requires_v2_db
LAST = "0050_open_food_facts_in_browser"


def sheet(fields: list[str] | None, **values) -> str:
    data = {"name": "Jus", "brand": "Soleil", "quantity": "1 L", "ean": "3000000000017", "composition": "Oranges",
            "nutriscore": "C", "nutriscore_version": "2023", "nova": "1", "nutrition_checked_at": "2026-11-01T10:00:00+00:00",
            **values}
    if fields is not None:
        data["off_source"] = {"code": "3000000000017", "checked_at": "2026-11-01T10:00:00+00:00", "fields": fields}
    return json.dumps(data)


@pytest.mark.asyncio
async def test_the_upgrade_drops_off_copies_and_keeps_what_contributors_wrote(monkeypatch):
    async with disposable_database("v2_off_browser_", migrate=False) as config:
        everything = dict(v2_migrations.MIGRATIONS)
        monkeypatch.setattr(v2_migrations, "MIGRATIONS", {key: value for key, value in everything.items() if key != LAST})
        await migrate_v2(config)
        connection = await connect_v2(config)
        try:
            author = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) VALUES('a','a','x','confirmed') RETURNING id")
            copied = await connection.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id", sheet(["name", "composition", "nutriscore"]))
            all_copied = await connection.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id", sheet(["composition", "nova"]))
            typed = await connection.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id", sheet(None))
            facts_only = await connection.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id", sheet(["name", "quantity"]))
            draft = await connection.fetchval(
                "INSERT INTO v2_product_drafts(author_id,product_id,base_revision,data) VALUES($1,$2,1,$3::jsonb) RETURNING id",
                author, copied, sheet(["brand", "nova"]))
            await connection.execute(
                "INSERT INTO v2_product_events(product_id,draft_id,actor_id,event_type,before_data,after_data) "
                "VALUES($1,$2,$3,'created',NULL,$4::jsonb)", copied, draft, author, sheet(["composition"]))
            await connection.execute(
                "INSERT INTO v2_product_off_snapshots(product_id,barcode,payload) VALUES($1,'3000000000017','{}')", copied)
        finally:
            await connection.close()

        monkeypatch.setattr(v2_migrations, "MIGRATIONS", everything)
        assert await migrate_v2(config) == [LAST]
        connection = await connect_v2(config)
        try:
            for table in ("v2_product_off_snapshots", "v2_off_refresh_queue", "v2_off_rate_events"):
                assert await connection.fetchval("SELECT to_regclass($1)", table) is None, table

            async def data(product_id):
                return json.loads(await connection.fetchval("SELECT data FROM v2_products WHERE id=$1", product_id))

            first = await data(copied)
            assert (first["composition"], first["nutriscore"], first["nutriscore_version"], first["nutrition_checked_at"]) == ("", "", "", None)
            assert first["nova"] == "1", "a field not copied from OFF stays"
            assert first["name"] == "Jus" and first["off_source"]["fields"] == ["name"]
            second = await data(all_copied)
            assert (second["composition"], second["nova"], second["off_source"]) == ("", "", None)
            assert second["nutriscore"] == "C"
            assert await data(typed) == json.loads(sheet(None)), "values typed by contributors stay"
            assert await data(facts_only) == json.loads(sheet(["name", "quantity"]))
            kept = json.loads(await connection.fetchval("SELECT data FROM v2_product_drafts WHERE id=$1", draft))
            assert (kept["nova"], kept["off_source"]["fields"], kept["composition"]) == ("", ["brand"], "Oranges")
            event = await connection.fetchrow("SELECT before_data,after_data FROM v2_product_events WHERE draft_id=$1", draft)
            assert event["before_data"] is None and json.loads(event["after_data"])["composition"] == ""
        finally:
            await connection.close()


def test_a_sheet_records_only_identifying_facts_copied_from_open_food_facts():
    source = products.OffSource.model_validate(
        {"code": "3000000000017", "checked_at": "2026-11-05T10:00:00+00:00", "fields": ["name", "composition", "nova", "ean"]})
    assert source.fields == ["name", "ean"]
    with pytest.raises(ValueError):
        products.OffSource.model_validate(
            {"code": "3000000000017", "checked_at": "2026-11-05T10:00:00+00:00", "fields": ["composition"]})


@pytest.mark.asyncio
async def test_the_server_no_longer_answers_for_open_food_facts():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test") as client:
        for path in ("/api/v2/products/off/search?q=jus", "/api/v2/products/off/product/3017620422003",
                     "/api/v2/products/1/off", "/api/v2/products/1/off-sources"):
            assert (await client.get(path)).status_code in (404, 405, 422), path
