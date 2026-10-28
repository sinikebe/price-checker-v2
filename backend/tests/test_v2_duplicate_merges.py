"""Duplicate report and merger preserve public references and enforce review clicks."""

from __future__ import annotations

import json
import os
import secrets
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import asyncpg
import httpx
import pytest
import pytest_asyncio

from app.api.v2 import duplicate_merges, moderation, prices, products, stores
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app
from app.services import v2_open_prices_sync as sync
from app.services import v2_off_refresh_queue as off_queue
from app.services.v2_open_prices_sync import _save_items as save_open_prices_items
from app.services.v2_open_prices_sync import _store as open_prices_store

MANUAL = (
    "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,source,price,observed_at,sales_channel) "
    "VALUES($1,$2,$3,'manual',1.11,'2026-02-03T12:00:00Z'::timestamptz,'drive')"
)

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable PostgreSQL required"
)


@pytest_asyncio.fixture
async def data(monkeypatch):
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    name = "v2_merge_" + secrets.token_hex(5)
    root = await connect_v2(base)
    try:
        await root.execute('CREATE DATABASE "' + name + '"')
    finally:
        await root.close()
    config = {**base, "database": name}
    await migrate_v2(config)
    connection = await connect_v2(config)
    try:
        users = {}
        for username, role in (("author", "confirmed"), ("admin", "admin")):
            uid = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) VALUES($1,$1,'test',$2) RETURNING id",
                username,
                role,
            )
            users[username] = {"id": uid, "username": username, "role": role}
        retailer = await connection.fetchval(
            "INSERT INTO v2_retailers(code,name) VALUES('test','Carrefour') RETURNING id"
        )
        stores_ids = []
        for n, osm in (("Carrefour City Paris", 101), ("Carrefour Paris", 102)):
            stores_ids.append(
                await connection.fetchval(
                    "INSERT INTO v2_stores(retailer_id,name,city,postal_code,osm_type,osm_id) VALUES($1,$2,'Paris','75001','node',$3) RETURNING id",
                    retailer,
                    n,
                    osm,
                )
            )
        product_ids = []
        for n, ean in (("Lait 1L", "11111111"), ("Lait bio 1L", "22222222")):
            product_ids.append(
                await connection.fetchval(
                    "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
                    json.dumps(
                        {
                            "name": n,
                            "brand": "Test",
                            "package": "Bouteille",
                            "quantity": "1 L",
                            "ean": ean,
                            "composition": "Lait" if ean == "22222222" else "",
                        }
                    ),
                )
            )
        offer = await connection.fetchval(
            "INSERT INTO v2_offers(retailer_id,store_id,source_kind,channel,title,price_amount,collected_at) "
            "VALUES($1,$2,'connector','drive','Lait',2,now()) RETURNING id",
            retailer,
            stores_ids[1],
        )
        await connection.execute(
            "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,offer_id,source,price,observed_at) "
            "VALUES($1,$2,$3,$4,'connector',2,now())",
            product_ids[1],
            retailer,
            stores_ids[1],
            offer,
        )
        await connection.execute(
            "INSERT INTO v2_store_aliases(store_id,source,name,name_key) VALUES($1,'retailer','City Paris','city paris')",
            stores_ids[1],
        )
        await connection.execute(
            "INSERT INTO v2_price_drafts(author_id,product_id,retailer_id,store_id,entry_kind,price,observed_at,sales_channel) "
            "VALUES($1,$2,$3,$4,'manual',2,now(),'drive')",
            users["author"]["id"],
            product_ids[1],
            retailer,
            stores_ids[1],
        )
        await connection.execute(
            "INSERT INTO v2_offer_product_links(offer_id,product_id,link_type,verified) VALUES($1,$2,'manual',true)",
            offer,
            product_ids[1],
        )
        for store_id in stores_ids:
            await connection.execute(
                "INSERT INTO v2_store_alias_proposals(store_id,author_id,source,name,name_key) "
                "VALUES($1,$2,'retailer','Autre nom','autre nom')",
                store_id,
                users["author"]["id"],
            )

        async def fake_connect():
            return await connect_v2(config)

        async def fake_user(_connection, request):
            return users.get(request.headers.get("x-test-user"))

        for module in (moderation, duplicate_merges, stores, products, prices):
            monkeypatch.setattr(module, "_connect", fake_connect)
        for module in (moderation, stores, prices):
            monkeypatch.setattr(module, "_current_user", fake_user)
        yield config, users, retailer, stores_ids, product_ids, offer
    finally:
        await connection.close()
        root = await connect_v2(base)
        try:
            await root.execute('DROP DATABASE "' + name + '" WITH (FORCE)')
        finally:
            await root.close()


def merge_body(preview):
    return {
        "duplicate_id": preview["duplicate_id"],
        "origin_revision": preview["origin_revision"],
        "duplicate_revision": preview["duplicate_revision"],
        "origin_fingerprint": preview["origin_fingerprint"],
        "duplicate_fingerprint": preview["duplicate_fingerprint"],
        "result": {f["key"]: f["suggested"] for f in preview["fields"]},
        "confirmed_fields": [
            f["key"] for f in preview["fields"] if f["state"] != "identical"
        ],
    }


@pytest.mark.asyncio
async def test_store_directory_duplicate_report_and_atomic_merge(data):
    config, _, retailer, ids, product_ids, offer = data
    connection = await connect_v2(config)
    try:
        for store_id in ids:
            await connection.execute(MANUAL, product_ids[0], retailer, store_id)
    finally:
        await connection.close()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://test"
    ) as client:
        directory = await client.get("/api/v2/stores")
        assert directory.status_code == 200, directory.text
        assert {item["id"] for item in directory.json()} == set(ids)
        report = await client.post(
            "/api/v2/moderation/reports",
            json={
                "kind": "store",
                "content_id": ids[0],
                "report_type": "duplicate",
                "duplicate_url": f"https://test/v2/magasins/{ids[1]}",
            },
            headers={"x-test-user": "author"},
        )
        assert report.status_code == 201, report.text
        report_id = report.json()["id"]
        queue = await client.get(
            "/api/v2/moderation/reports", headers={"x-test-user": "admin"}
        )
        assert queue.status_code == 200 and queue.json()[0]["duplicate_id"] == ids[1]
        preview = await client.get(
            f"/api/v2/moderation/reports/{report_id}/merge-preview",
            params={"duplicate_id": ids[1]},
            headers={"x-test-user": "admin"},
        )
        assert preview.status_code == 200, preview.text
        body = merge_body(preview.json())
        missing = await client.post(
            f"/api/v2/moderation/reports/{report_id}/merge",
            json={**body, "confirmed_fields": []},
            headers={"x-test-user": "admin"},
        )
        assert missing.status_code == 422, missing.text
        merged = await client.post(
            f"/api/v2/moderation/reports/{report_id}/merge",
            json=body,
            headers={"x-test-user": "admin"},
        )
        assert merged.status_code == 200, merged.text
        assert ids[1] not in {
            item["id"] for item in (await client.get("/api/v2/stores")).json()
        }
        old = (await client.get(f"/api/v2/stores/{ids[1]}")).json()
        assert old["merged_to_id"] == ids[0]
        matched = await client.get(
            "/api/v2/stores/matches",
            params={
                "retailer": "Carrefour",
                "name": "Carrefour Paris",
                "city": "Paris",
                "postal_code": "75001",
            },
        )
        assert matched.status_code == 200 and matched.json()["exact_store_id"] == ids[0]
        connection = await connect_v2(config)
        try:
            assert (
                await connection.fetchval(
                    "SELECT store_id FROM v2_offers WHERE id=$1", offer
                )
                == ids[0]
            )
            assert (
                await connection.fetchval(
                    "SELECT store_id FROM v2_price_observations WHERE offer_id=$1",
                    offer,
                )
                == ids[0]
            )
            assert (
                await connection.fetchval(
                    "SELECT count(*) FROM v2_store_aliases WHERE store_id=$1", ids[0]
                )
                == 2
            )
            assert (
                await connection.fetchval(
                    "SELECT store_id FROM v2_price_drafts LIMIT 1"
                )
                == ids[0]
            )
            assert (
                await connection.fetchval(
                    "SELECT count(*) FROM v2_store_alias_proposals WHERE store_id=$1 AND status='pending'",
                    ids[0],
                )
                == 1
            )
            assert (
                await connection.fetchval(
                    "SELECT count(*) FROM v2_store_alias_proposals WHERE store_id=$1 AND status='rejected'",
                    ids[1],
                )
                == 1
            )
            location = {
                "id": 44102,
                "osm_type": "NODE",
                "osm_id": 102,
                "osm_address_city": "Paris",
                "osm_address_postcode": "75001",
                "osm_name": "Carrefour Paris",
            }
            assert await open_prices_store(connection, location) == (retailer, ids[0], None)
            observations = await connection.fetch(
                "SELECT merge_duplicate_of_id FROM v2_price_observations "
                "WHERE product_id=$1 AND store_id=$2 AND source='manual' ORDER BY id",
                product_ids[0],
                ids[0],
            )
            assert (
                len(observations) == 2
                and sum(
                    row["merge_duplicate_of_id"] is not None for row in observations
                )
                == 1
            )
            with pytest.raises(asyncpg.UniqueViolationError):
                await connection.execute(MANUAL, product_ids[0], retailer, ids[0])
        finally:
            await connection.close()


@pytest.mark.asyncio
async def test_product_merge_preserves_observations_and_barcode_route(data, monkeypatch):
    config, _, retailer, ids, product_ids, offer = data
    connection = await connect_v2(config)
    try:
        for product_id in product_ids:
            await connection.execute(MANUAL, product_id, retailer, ids[0])
        assert await save_open_prices_items(
            connection, product_ids[1], "22222222",
            [open_price("22222222", 61001, location_id=66101, osm_id=66101)]
        ) == 1
        for product_id, barcode in zip(product_ids, ("11111111", "22222222")):
            await connection.execute(
                "INSERT INTO v2_product_off_snapshots(product_id,barcode,payload) "
                "VALUES($1,$2,$3::jsonb)",
                product_id, barcode, json.dumps({"code": barcode}),
            )
        await connection.execute(
            "INSERT INTO v2_off_refresh_queue(product_id,next_attempt_at) "
            "VALUES($1,now()-interval '1 minute')", product_ids[1],
        )
    finally:
        await connection.close()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://test"
    ) as client:
        report = await client.post(
            "/api/v2/moderation/reports",
            json={
                "kind": "product",
                "content_id": product_ids[0],
                "report_type": "duplicate",
            },
            headers={"x-test-user": "author"},
        )
        assert report.status_code == 201, report.text
        report_id = report.json()["id"]
        preview = await client.get(
            f"/api/v2/moderation/reports/{report_id}/merge-preview",
            params={"duplicate_id": product_ids[1]},
            headers={"x-test-user": "admin"},
        )
        assert preview.status_code == 200, preview.text
        body = merge_body(preview.json())
        merged = await client.post(
            f"/api/v2/moderation/reports/{report_id}/merge",
            json=body,
            headers={"x-test-user": "admin"},
        )
        assert merged.status_code == 200, merged.text
        visible = (await client.get("/api/v2/products")).json()
        assert product_ids[1] not in {item["id"] for item in visible}
        assert (await client.get(f"/api/v2/products/{product_ids[1]}")).json()[
            "merged_to_id"
        ] == product_ids[0]
        barcode = await client.get("/api/v2/products/by-barcode/22222222")
        assert barcode.status_code == 200 and barcode.json()["id"] == product_ids[0]
        capture = await client.post(
            f"/api/v2/prices/products/{product_ids[0]}/capture-drafts",
            json={"ean": "22222222", "source_url": "https://www.carrefour.fr/p/test",
                  "price": {"retailer": "Carrefour", "store_id": ids[0],
                            "store_name": "Carrefour City Paris",
                            "city": "Paris", "postal_code": "75001",
                            "sales_channel": "drive", "price": "3.49",
                            "observed_at": date.today().isoformat()}},
            headers={"x-test-user": "author"},
        )
        assert capture.status_code == 201, capture.text
        reviewed = await client.post(
            f"/api/v2/prices/drafts/{capture.json()['id']}/approve",
            headers={"x-test-user": "admin"},
        )
        assert reviewed.status_code == 200, reviewed.text
        sources = await client.get(f"/api/v2/products/{product_ids[0]}/off-sources")
        assert sources.status_code == 200, sources.text
        assert {row["barcode"] for row in sources.json()} == {"11111111", "22222222"}
        old_off = await client.get(
            f"/api/v2/products/{product_ids[0]}/off", params={"barcode": "22222222"}
        )
        assert old_off.status_code == 200, old_off.text
        assert old_off.json()["source_product_id"] == product_ids[1]
        connection = await connect_v2(config)
        try:
            assert (
                await connection.fetchval(
                    "SELECT product_id FROM v2_price_observations WHERE offer_id=$1",
                    offer,
                )
                == product_ids[0]
            )
            assert (
                await connection.fetchval(
                    "SELECT product_id FROM v2_price_drafts LIMIT 1"
                )
                == product_ids[0]
            )
            assert (
                await connection.fetchval(
                    "SELECT product_id FROM v2_offer_product_links WHERE offer_id=$1",
                    offer,
                )
                == product_ids[0]
            )
            observations = await connection.fetch(
                "SELECT merge_duplicate_of_id FROM v2_price_observations "
                "WHERE product_id=$1 AND store_id=$2 AND source='manual' ORDER BY id",
                product_ids[0],
                ids[0],
            )
            assert len(observations) == 2
            assert (
                sum(row["merge_duplicate_of_id"] is not None for row in observations)
                == 1
            )
            with pytest.raises(asyncpg.UniqueViolationError):
                await connection.execute(MANUAL, product_ids[0], retailer, ids[0])
            before = await connection.fetchval("SELECT count(*) FROM v2_stores")
            assert await save_open_prices_items(
                connection, product_ids[0], "22222222",
                [open_price("22222222", 61001, location_id=66101, osm_id=66101)]
            ) == 0
            assert await save_open_prices_items(
                connection, product_ids[0], "22222222",
                [open_price("22222222", 61002, location_id=66101, osm_id=66101)]
            ) == 1
            assert await connection.fetchval("SELECT count(*) FROM v2_stores") == before
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_price_observations "
                "WHERE product_id=$1 AND source_provider='open_prices'",
                product_ids[0],
            ) == 2
            async def fake_connect():
                return await connect_v2(config)
            monkeypatch.setattr(sync, "_connect", fake_connect)
            monkeypatch.setattr(sync, "_read_config", lambda: config)
            monkeypatch.setattr(sync, "get_settings", lambda: SimpleNamespace(APP_ENV="dev"))
            monkeypatch.setattr(sync, "MIN_INTERVAL_SECONDS", 0)
            await connection.execute(
                "UPDATE v2_open_prices_sync_control SET next_run_at=now()-interval '1 minute'"
            )
            requested_codes = []
            def respond(request):
                requested_codes.append(request.url.params["product_code"])
                return httpx.Response(200, json={"items": []})
            async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as sync_client:
                cycle = await sync.run_sync_cycle(sync_client)
            assert cycle["requested"] == 2
            assert set(requested_codes) == {"11111111", "22222222"}
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_open_prices_sync_state WHERE product_id=$1",
                product_ids[0],
            ) == 2
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_off_refresh_queue WHERE product_id=$1",
                product_ids[1],
            ) == 1
            async def fetch_old_off(barcode):
                assert barcode == "22222222"
                return {"code": barcode, "rev": 2}
            monkeypatch.setattr(off_queue, "_connect", fake_connect)
            monkeypatch.setattr(off_queue, "fetch_full_off_product", fetch_old_off)
            assert await off_queue.run_due_refresh_once() == "updated"
            assert await connection.fetchval(
                "SELECT off_rev FROM v2_product_off_snapshots WHERE product_id=$1",
                product_ids[1],
            ) == 2
        finally:
            await connection.close()


@pytest.mark.asyncio
async def test_review_is_private_and_rejects_stale_store_comparison(data):
    config, _, _, ids, _, _ = data
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://test"
    ) as client:
        anonymous = await client.post(
            "/api/v2/moderation/reports",
            json={"kind": "store", "content_id": ids[0], "report_type": "duplicate"},
        )
        assert anonymous.status_code == 401
        invalid = await client.post(
            "/api/v2/moderation/reports",
            json={
                "kind": "store",
                "content_id": ids[0],
                "report_type": "duplicate",
                "duplicate_url": "https://test/v2/produits/2",
            },
            headers={"x-test-user": "author"},
        )
        assert invalid.status_code == 422
        report = await client.post(
            "/api/v2/moderation/reports",
            json={"kind": "store", "content_id": ids[0], "report_type": "duplicate"},
            headers={"x-test-user": "author"},
        )
        assert report.status_code == 201, report.text
        report_id = report.json()["id"]
        forbidden = await client.get(
            f"/api/v2/moderation/reports/{report_id}/merge-preview",
            params={"duplicate_id": ids[1]},
            headers={"x-test-user": "author"},
        )
        assert forbidden.status_code == 403
        preview = await client.get(
            f"/api/v2/moderation/reports/{report_id}/merge-preview",
            params={"duplicate_id": ids[1]},
            headers={"x-test-user": "admin"},
        )
        assert preview.status_code == 200, preview.text
        connection = await connect_v2(config)
        try:
            await connection.execute(
                "UPDATE v2_stores SET city='Lyon' WHERE id=$1", ids[1]
            )
        finally:
            await connection.close()
        stale = await client.post(
            f"/api/v2/moderation/reports/{report_id}/merge",
            json=merge_body(preview.json()),
            headers={"x-test-user": "admin"},
        )
        assert stale.status_code == 409, stale.text
        connection = await connect_v2(config)
        try:
            assert (
                await connection.fetchval(
                    "SELECT status FROM v2_content_reports WHERE id=$1", report_id
                )
                == "open"
            )
        finally:
            await connection.close()


def open_price(barcode: str, price_id: int, *, location_id: int = 55103,
               osm_id: int = 1103, brand: str = "Carrefour City") -> dict:
    return {
        "id": price_id, "type": "PRODUCT", "product_code": barcode,
        "price": 2.49, "currency": "EUR", "date": date.today().isoformat(),
        "price_is_discounted": False, "duplicate_of": None,
        "location": {
            "id": location_id, "type": "OSM", "osm_type": "NODE",
            "osm_id": osm_id, "osm_name": "Carrefour City Paris",
            "osm_brand": brand, "osm_address_city": "Paris",
            "osm_address_postcode": "75001",
            "osm_address_country_code": "FR",
        },
    }


@pytest.mark.asyncio
async def test_cross_retailer_store_merge_keeps_sources_and_reimports_to_canonical(data):
    config, users, canonical_retailer, ids, products_ids, _ = data
    connection = await connect_v2(config)
    try:
        variant = await connection.fetchval(
            "INSERT INTO v2_retailers(code,name) VALUES('city','Carrefour City') RETURNING id"
        )
        assert await connection.fetchval(
            "SELECT a.group_id=b.group_id FROM v2_retailers a "
            "JOIN v2_retailers b ON b.id=$2 WHERE a.id=$1",
            canonical_retailer, variant,
        )
        donor = await connection.fetchval(
            "INSERT INTO v2_stores(retailer_id,name,city,postal_code,osm_type,osm_id,import_key) "
            "VALUES($1,'Carrefour City Paris','Paris','75001','node',1103,"
            "'open_prices:location:55103') RETURNING id",
            variant,
        )
        await connection.execute(MANUAL, products_ids[0], canonical_retailer, ids[0])
        await connection.execute(MANUAL, products_ids[0], variant, donor)
        offer = await connection.fetchval(
            "INSERT INTO v2_offers(retailer_id,store_id,source_kind,channel,title,price_amount,collected_at) "
            "VALUES($1,$2,'connector','drive','Lait',2,now()) RETURNING id",
            variant, donor,
        )
        await connection.execute(
            "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,offer_id,source,price,observed_at) "
            "VALUES($1,$2,$3,$4,'connector',2,now())",
            products_ids[1], variant, donor, offer,
        )
        draft = await connection.fetchval(
            "INSERT INTO v2_price_drafts(author_id,product_id,retailer_id,store_id,"
            "entry_kind,price,observed_at,sales_channel) "
            "VALUES($1,$2,$3,$4,'manual',2,now(),'drive') RETURNING id",
            users["author"]["id"], products_ids[1], variant, donor,
        )
        assert await save_open_prices_items(
            connection, products_ids[1], "22222222", [open_price("22222222", 51001)]
        ) == 1
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://test"
        ) as client:
            report = await client.post(
                "/api/v2/moderation/reports",
                json={"kind": "store", "content_id": ids[0],
                      "report_type": "duplicate", "duplicate_url": f"https://test/v2/magasins/{donor}"},
                headers={"x-test-user": "author"},
            )
            assert report.status_code == 201, report.text
            preview = await client.get(
                f"/api/v2/moderation/reports/{report.json()['id']}/merge-preview",
                params={"duplicate_id": donor}, headers={"x-test-user": "admin"},
            )
            assert preview.status_code == 200, preview.text
            assert preview.json()["origin_retailer"] == "Carrefour"
            assert preview.json()["duplicate_retailer"] == "Carrefour City"
            merged = await client.post(
                f"/api/v2/moderation/reports/{report.json()['id']}/merge",
                json=merge_body(preview.json()), headers={"x-test-user": "admin"},
            )
            assert merged.status_code == 200, merged.text
            directory = (await client.get("/api/v2/stores")).json()
            assert donor not in {item["id"] for item in directory}
            matched = (await client.get(
                "/api/v2/stores/matches",
                params={"retailer": "Carrefour City", "name": "Carrefour City Paris",
                        "city": "Paris", "postal_code": "75001"},
            )).json()
            assert matched["exact_store_id"] == ids[0]
            captured = await client.post(
                f"/api/v2/prices/products/{products_ids[1]}/capture-drafts",
                json={"ean": "22222222", "source_url": "https://www.carrefour.fr/p/test",
                      "price": {"retailer": "Carrefour City", "store_id": ids[0],
                                "store_name": "Carrefour City Paris",
                                "city": "Paris", "postal_code": "75001",
                                "sales_channel": "in_store", "price": "3.49",
                                "observed_at": date.today().isoformat()}},
                headers={"x-test-user": "author"},
            )
            assert captured.status_code == 201, captured.text
            assert await connection.fetchval(
                "SELECT source_retailer_id FROM v2_price_drafts WHERE id=$1",
                captured.json()["id"],
            ) == variant
            reviewed = await client.post(
                f"/api/v2/prices/drafts/{captured.json()['id']}/approve",
                headers={"x-test-user": "admin"},
            )
            assert reviewed.status_code == 200, reviewed.text
            assert await connection.fetchval(
                "SELECT source_retailer_id FROM v2_price_observations WHERE id=$1",
                reviewed.json()["observation_id"],
            ) == variant
            history = (await client.get(f"/api/v2/prices/products/{products_ids[1]}")).json()
            assert any(row["store_id"] == ids[0] and
                       row["source_retailer"] == "Carrefour City"
                       for row in history["observations"])
        for table in ("v2_price_drafts", "v2_offers", "v2_price_observations"):
            rows = await connection.fetch(
                f"SELECT retailer_id,store_id,source_retailer_id FROM {table} "
                "WHERE source_retailer_id=$1", variant,
            )
            assert rows and all(row["retailer_id"] == canonical_retailer
                                and row["store_id"] == ids[0] for row in rows)
        assert await connection.fetchval(
            "SELECT store_id FROM v2_price_drafts WHERE id=$1", draft,
        ) == ids[0]
        assert await open_prices_store(
            connection, open_price("22222222", 51002, osm_id=9999)["location"]
        ) == (canonical_retailer, ids[0], variant)
        before = await connection.fetchval("SELECT count(*) FROM v2_stores")
        assert await save_open_prices_items(
            connection, products_ids[1], "22222222",
            [open_price("22222222", 51001, osm_id=9999)]
        ) == 0
        assert await save_open_prices_items(
            connection, products_ids[1], "22222222",
            [open_price("22222222", 51002, osm_id=9999)]
        ) == 1
        assert await connection.fetchval("SELECT count(*) FROM v2_stores") == before
        assert await connection.fetchval(
            "SELECT store_id FROM v2_price_observations "
            "WHERE source_provider='open_prices' AND source_record_id='51002'"
        ) == ids[0]
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_cross_group_store_merge_is_refused(data):
    config, _, retailer, ids, product_ids, _ = data
    connection = await connect_v2(config)
    try:
        other = await connection.fetchval(
            "INSERT INTO v2_retailers(code,name) VALUES('other','Unrelated') RETURNING id"
        )
        donor = await connection.fetchval(
            "INSERT INTO v2_stores(retailer_id,name,city,postal_code,osm_type,osm_id) "
            "VALUES($1,'Unrelated Paris','Paris','75001','node',9999) RETURNING id", other,
        )
        await connection.execute(MANUAL, product_ids[0], other, donor)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://test"
        ) as client:
            report = await client.post(
                "/api/v2/moderation/reports",
                json={"kind": "store", "content_id": ids[0], "report_type": "duplicate"},
                headers={"x-test-user": "author"},
            )
            preview = await client.get(
                f"/api/v2/moderation/reports/{report.json()['id']}/merge-preview",
                params={"duplicate_id": donor}, headers={"x-test-user": "admin"},
            )
            assert preview.status_code == 422
    finally:
        await connection.close()
