"""Duplicate report and merger preserve public references and enforce review clicks."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

from app.api.v2 import duplicate_merges, moderation, products, stores
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app
from app.services.v2_open_prices_sync import _store as open_prices_store

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

        for module in (moderation, duplicate_merges, stores, products):
            monkeypatch.setattr(module, "_connect", fake_connect)
        for module in (moderation, stores):
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
    config, _, retailer, ids, _, offer = data
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
                "osm_type": "NODE",
                "osm_id": 102,
                "osm_address_city": "Paris",
                "osm_address_postcode": "75001",
                "osm_name": "Carrefour Paris",
            }
            assert await open_prices_store(connection, location) == (retailer, ids[0])
        finally:
            await connection.close()


@pytest.mark.asyncio
async def test_product_merge_preserves_observations_and_barcode_route(data):
    config, _, _, _, product_ids, offer = data
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
