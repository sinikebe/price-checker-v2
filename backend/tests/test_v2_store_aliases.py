"""Captured store matching, private aliases, and separate moderation."""

from __future__ import annotations

import json
import os
import secrets
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import pytest
import pytest_asyncio
from app.api.v2 import prices, products, stores
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app
from app.services.v2_open_prices_sync import _store as open_prices_store

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


@pytest_asyncio.fixture
async def isolated_config():
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_store_" + secrets.token_hex(5)
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
async def test_capture_store_aliases_and_distinct_review(monkeypatch, isolated_config):
    connection = await connect_v2(isolated_config)
    try:
        users = {}
        for name, role in (("author", "confirmed"), ("other", "visitor"), ("admin", "admin")):
            user_id = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES($1,$1,'test',$2) RETURNING id", "store_" + name, role,
            )
            users[name] = {"id": user_id, "username": name, "role": role}
        retailer_id = await connection.fetchval(
            "INSERT INTO v2_retailers(code,name) VALUES('test-carrefour','Carrefour') RETURNING id"
        )
        existing_id = await connection.fetchval(
            "INSERT INTO v2_stores(retailer_id,name,city,postal_code,osm_type,osm_id) "
            "VALUES($1,'Carrefour City Maisons-Laffitte','Maisons Laffitte','78600','node',1001) "
            "RETURNING id", retailer_id,
        )
        second_id = await connection.fetchval(
            "INSERT INTO v2_stores(retailer_id,name,city,postal_code,osm_type,osm_id) "
            "VALUES($1,'Carrefour Market Maisons-Laffitte','Maisons Laffitte','78600','node',1002) "
            "RETURNING id", retailer_id,
        )
        private_id = await connection.fetchval(
            "INSERT INTO v2_stores(retailer_id,name,city,postal_code) "
            "VALUES($1,'Carrefour Secret','Paris','75001') RETURNING id", retailer_id,
        )
        # A private store belongs to the author only until its price is approved.
        private_product_id = await connection.fetchval(
            "INSERT INTO v2_products(data) VALUES('{\"ean\":\"\"}'::jsonb) RETURNING id"
        )
        await connection.execute(
            "INSERT INTO v2_price_drafts(author_id,product_id,retailer_id,store_id,entry_kind,"
            "price,observed_at,sales_channel) "
            "VALUES($1,$2,$3,$4,'manual',1.00,now(),'drive')",
            users["author"]["id"], private_product_id, retailer_id, private_id,
        )

        async def fake_connect():
            return await connect_v2(isolated_config)

        async def fake_user(_connection, request):
            return users.get(request.headers.get("x-test-user"))

        for module in (prices, products, stores):
            monkeypatch.setattr(module, "_connect", fake_connect)
            monkeypatch.setattr(module, "_current_user", fake_user)

        endpoint = "/api/v2/stores/matches"
        params = {"retailer": "Carrefour", "name": "City Maisons Laffitte",
                  "city": "Maisons Laffitte", "postal_code": "78600"}
        day = datetime.now(ZoneInfo("Europe/Paris")).date().isoformat()
        body = {
            "ean": "3059946163611", "source_url": "https://www.carrefour.fr/p/test",
            "product_data": {"ean": "3059946163611", "name": "Fixture product",
                             "brand": "Fixture", "package": "pack", "quantity": "250 g"},
            "price": {"retailer": "Carrefour", "store_name": "Carrefour City Maisons-Laffitte",
                      "city": "Maisons Laffitte", "postal_code": "78600", "store_id": existing_id,
                      "captured_store_name": "City Maisons Laffitte", "propose_store_alias": True,
                      "sales_channel": "drive", "price": "5.95", "observed_at": day},
        }
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://test"
        ) as client:
            initial = await client.get(endpoint, params=params)
            assert initial.status_code == 200, initial.text
            assert initial.json()["exact_store_id"] is None
            assert initial.json()["matches"][0]["id"] == existing_id
            assert initial.json()["matches"][0]["match"] == "near"
            assert (await client.get(endpoint, params={"retailer": "Carrefour",
                "name": "Carrefour Secret"}, headers={"x-test-user": "other"})).json()["matches"] == []
            own_private = await client.get(endpoint, params={"retailer": "Carrefour",
                "name": "Carrefour Secret"}, headers={"x-test-user": "author"})
            assert own_private.json()["exact_store_id"] == private_id

            mismatch = await client.post("/api/v2/prices/capture-drafts", json={**body,
                "price": {**body["price"], "retailer": "Auchan"}},
                headers={"x-test-user": "author"})
            assert mismatch.status_code == 422, mismatch.text
            assert await connection.fetchval("SELECT count(*) FROM v2_product_drafts") == 0
            assert await connection.fetchval("SELECT count(*) FROM v2_store_alias_proposals") == 0

            sent = await client.post("/api/v2/prices/capture-drafts", json=body,
                                     headers={"x-test-user": "author"})
            assert sent.status_code == 201, sent.text
            proposal_id = sent.json()["alias_proposal_id"]
            assert proposal_id is not None
            product_draft_id = sent.json()["product_draft_id"]
            price_draft_id = sent.json()["price_draft_id"]
            assert await connection.fetchval(
                "SELECT captured_store_name FROM v2_price_drafts WHERE id=$1", price_draft_id,
            ) == "City Maisons Laffitte"
            assert await connection.fetchval("SELECT count(*) FROM v2_store_aliases") == 0
            assert (await client.get("/api/v2/stores/alias-proposals/pending",
                headers={"x-test-user": "other"})).status_code == 403
            pending = await client.get("/api/v2/stores/alias-proposals/pending",
                                       headers={"x-test-user": "admin"})
            assert pending.json()[0]["id"] == proposal_id
            assert (await client.post(f"/api/v2/stores/alias-proposals/{proposal_id}/review",
                json={"action": "approve"}, headers={"x-test-user": "other"})).status_code == 403

            # Product and price can be approved while the store alias remains pending.
            published = await client.post(
                f"/api/v2/products/drafts/{product_draft_id}/approve",
                json={"revision": 1}, headers={"x-test-user": "admin"},
            )
            assert published.status_code == 200, published.text
            price_review = await client.post(
                f"/api/v2/prices/drafts/{price_draft_id}/approve",
                headers={"x-test-user": "admin"},
            )
            assert price_review.status_code == 200, price_review.text
            assert await connection.fetchval(
                "SELECT status FROM v2_store_alias_proposals WHERE id=$1", proposal_id,
            ) == "pending"
            approved = await client.post(
                f"/api/v2/stores/alias-proposals/{proposal_id}/review",
                json={"action": "approve"}, headers={"x-test-user": "admin"},
            )
            assert approved.status_code == 200, approved.text
            matched = await client.get(endpoint, params=params)
            assert matched.json()["exact_store_id"] == existing_id
            assert matched.json()["matches"][0]["match"] == "exact"
            assert (await client.post(
                f"/api/v2/stores/alias-proposals/{proposal_id}/review",
                json={"action": "approve"}, headers={"x-test-user": "admin"},
            )).status_code == 409

            external = await client.post(f"/api/v2/stores/{second_id}/alias-proposals",
                json={"name": "Carrefour Central", "source": "open_prices"},
                headers={"x-test-user": "author"})
            assert external.status_code == 201, external.text
            external_id = external.json()["id"]
            assert (await client.get(endpoint, params={"retailer": "Carrefour",
                "name": "Carrefour Central", "source": "open_prices"})).json()["exact_store_id"] is None
            assert (await client.post(
                f"/api/v2/stores/alias-proposals/{external_id}/review",
                json={"action": "reject"}, headers={"x-test-user": "admin"},
            )).status_code == 200
            assert (await client.get(endpoint, params={"retailer": "Carrefour",
                "name": "Carrefour Central", "source": "open_prices"})).json()["exact_store_id"] is None

            alias_target = await connection.fetchval(
                "INSERT INTO v2_stores(retailer_id,name,city,postal_code) "
                "VALUES($1,'Carrefour Clos','Maisons Laffitte','78600') RETURNING id",
                retailer_id,
            )
            proposed = await client.post(f"/api/v2/stores/{alias_target}/alias-proposals",
                json={"name": "Carrefour Clos Open Prices", "source": "open_prices"},
                headers={"x-test-user": "admin"})
            assert proposed.status_code == 201, proposed.text
            assert (await client.post(
                f"/api/v2/stores/alias-proposals/{proposed.json()['id']}/review",
                json={"action": "approve"}, headers={"x-test-user": "admin"},
            )).status_code == 200
            identity = await open_prices_store(connection, {
                "osm_type": "NODE", "osm_id": 9999, "id": 9999,
                "osm_brand": "Carrefour", "osm_name": "Carrefour Clos Open Prices",
                "osm_address_city": "Maisons Laffitte", "osm_address_postcode": "78600",
            })
            assert identity == (retailer_id, alias_target)
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_stores WHERE osm_id=9999"
            ) == 0
            # Removing a reviewer account must not revoke an approved name.
            temporary_reviewer = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES('store_temp_review','store_temp_review','test','admin') RETURNING id"
            )
            await connection.execute(
                "UPDATE v2_store_aliases SET approved_by=$1 WHERE store_id=$2",
                temporary_reviewer, alias_target,
            )
            await connection.execute(
                "UPDATE v2_store_alias_proposals SET reviewed_by=$1 WHERE id=$2",
                temporary_reviewer, proposed.json()["id"],
            )
            await connection.execute("DELETE FROM v2_users WHERE id=$1", temporary_reviewer)
            assert await connection.fetchval(
                "SELECT approved_by FROM v2_store_aliases WHERE store_id=$1", alias_target,
            ) is None
            assert await connection.fetchval(
                "SELECT status FROM v2_store_alias_proposals WHERE id=$1",
                proposed.json()["id"],
            ) == "approved"
    finally:
        await connection.close()
