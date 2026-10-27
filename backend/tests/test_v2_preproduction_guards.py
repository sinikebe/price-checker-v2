"""Regression checks for approval review and post-bootstrap setup access."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from app.api.v2 import auth, products, setup
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


@pytest_asyncio.fixture
async def isolated_db(monkeypatch):
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_p0_" + secrets.token_hex(5)
    root = await connect_v2(base)
    try:
        await root.execute('CREATE DATABASE "' + database + '"')
    finally:
        await root.close()
    config = {**base, "database": database}
    try:
        await migrate_v2(config)
        monkeypatch.setattr(auth, "_read_config", lambda: config)
        monkeypatch.setattr(setup, "_read_config", lambda: config)
        monkeypatch.setattr(setup, "_access_code", lambda: "test-install-code")
        yield config
    finally:
        root = await connect_v2(base)
        try:
            await root.execute('DROP DATABASE "' + database + '" WITH (FORCE)')
        finally:
            await root.close()


async def _admin_session(config):
    connection = await connect_v2(config)
    try:
        admin_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('admin','admin','unused-ci-hash','admin') RETURNING id"
        )
        await connection.execute(
            "UPDATE v2_installation SET admin_user_id=$1 WHERE singleton=true",
            admin_id,
        )
        token = secrets.token_urlsafe(32)
        await connection.execute(
            "INSERT INTO v2_sessions(token_hash,user_id,expires_at) "
            "VALUES($1,$2,now()+interval '1 hour')",
            hashlib.sha256(token.encode()).hexdigest(), admin_id,
        )
        return admin_id, token
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_setup_requires_admin_after_bootstrap(isolated_db):
    config = isolated_db
    transport = httpx.ASGITransport(app=app, client=("192.0.2.3", 443))
    async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
        payload = {"access_code": "test-install-code"}
        assert (await client.post(
            "/api/v2/setup/database/details", json=payload
        )).status_code == 200
        _, token = await _admin_session(config)
        assert (await client.post(
            "/api/v2/setup/database/details", json=payload
        )).status_code == 403
        client.cookies.set("pc_v2_session", token, path="/api/v2")
        assert (await client.post(
            "/api/v2/setup/database/details", json=payload
        )).status_code == 200


@pytest.mark.asyncio
async def test_approval_rejects_draft_changed_after_review(isolated_db):
    config = isolated_db
    _, token = await _admin_session(config)
    connection = await connect_v2(config)
    try:
        author_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('author','author','unused-ci-hash','visitor') RETURNING id"
        )
        initial = {
            "name": "Reviewed name", "brand": "CI",
            "package": "Box", "quantity": "100 g",
        }
        draft_id = await connection.fetchval(
            "INSERT INTO v2_product_drafts(author_id,data) "
            "VALUES($1,$2::jsonb) RETURNING id",
            author_id, json.dumps(initial),
        )
        transport = httpx.ASGITransport(app=app, client=("192.0.2.4", 443))
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            client.cookies.set("pc_v2_session", token, path="/api/v2")
            reviewed = await client.get(f"/api/v2/products/drafts/{draft_id}")
            assert reviewed.status_code == 200
            assert reviewed.json()["revision"] == 1
            changed = {**initial, "name": "Changed after review"}
            await connection.execute(
                "UPDATE v2_product_drafts SET data=$1::jsonb,revision=2 "
                "WHERE id=$2", json.dumps(changed), draft_id,
            )
            stale = await client.post(
                f"/api/v2/products/drafts/{draft_id}/approve",
                json={"revision": 1},
            )
            assert stale.status_code == 409
            assert await connection.fetchval("SELECT count(*) FROM v2_products") == 0
            current = await client.post(
                f"/api/v2/products/drafts/{draft_id}/approve",
                json={"revision": 2},
            )
            assert current.status_code == 200
            assert current.json()["data"]["name"] == "Changed after review"
    finally:
        await connection.close()



@pytest.mark.asyncio
async def test_product_draft_quota_is_atomic_under_concurrent_creates(
    isolated_db, monkeypatch,
):
    config = isolated_db
    monkeypatch.setattr(products, "MAX_PRODUCT_DRAFTS", 2)
    connection = await connect_v2(config)
    try:
        user_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('writer','writer','unused-ci-hash','visitor') RETURNING id"
        )
        token = secrets.token_urlsafe(32)
        await connection.execute(
            "INSERT INTO v2_sessions(token_hash,user_id,expires_at) "
            "VALUES($1,$2,now()+interval '1 hour')",
            hashlib.sha256(token.encode()).hexdigest(), user_id,
        )
        transport = httpx.ASGITransport(app=app, client=("192.0.2.5", 443))
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            client.cookies.set("pc_v2_session", token, path="/api/v2")
            responses = await asyncio.gather(*(
                client.post(
                    "/api/v2/products/drafts",
                    json={"data": {"name": f"Draft {index}"}},
                )
                for index in range(3)
            ))
        assert sorted(response.status_code for response in responses) == [201, 201, 429]
        assert await connection.fetchval(
            "SELECT count(*) FROM v2_product_drafts WHERE author_id=$1", user_id,
        ) == 2
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_report_withdrawal_hides_product_history_and_prices(isolated_db):
    config = isolated_db
    admin_id, admin_token = await _admin_session(config)
    connection = await connect_v2(config)
    try:
        user_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('reporter','reporter','unused-ci-hash','visitor') RETURNING id"
        )
        user_token = secrets.token_urlsafe(32)
        await connection.execute(
            "INSERT INTO v2_sessions(token_hash,user_id,expires_at) "
            "VALUES($1,$2,now()+interval '1 hour')",
            hashlib.sha256(user_token.encode()).hexdigest(), user_id,
        )
        product_id = await connection.fetchval(
            "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
            json.dumps({"name": "Reported product", "brand": "CI", "quantity": "100 g"}),
        )
        await connection.execute(
            "INSERT INTO v2_retailers(code,name) VALUES('ci','CI')"
        )
        await connection.execute(
            "INSERT INTO v2_stores(retailer_id,name) "
            "SELECT id,'CI store' FROM v2_retailers WHERE code='ci'"
        )
        await connection.execute(
            "INSERT INTO v2_price_observations"
            "(product_id,retailer_id,store_id,source,price,observed_at) "
            "SELECT $1,r.id,s.id,'manual',3.99,now() "
            "FROM v2_retailers r JOIN v2_stores s ON s.retailer_id=r.id "
            "WHERE r.code='ci'",
            product_id,
        )
        transport = httpx.ASGITransport(app=app, client=("192.0.2.6", 443))
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            client.cookies.set("pc_v2_session", user_token, path="/api/v2")
            report = await client.post(
                "/api/v2/moderation/reports",
                json={"kind": "product", "content_id": product_id,
                      "reason": "Contenu à retirer pour le test"},
            )
            assert report.status_code == 201, report.text
            report_id = report.json()["id"]
            assert (await client.get("/api/v2/moderation/reports")).status_code == 403
            client.cookies.set("pc_v2_session", admin_token, path="/api/v2")
            assert len((await client.get("/api/v2/moderation/reports")).json()) == 1
            withdrawal = await client.post(
                f"/api/v2/moderation/reports/{report_id}/resolve",
                json={"action": "withdraw"},
            )
            assert withdrawal.status_code == 200, withdrawal.text
            assert product_id in (await client.get("/api/v2/moderation/withdrawn")).json()["product_ids"]
            assert all(item["id"] != product_id for item in (await client.get("/api/v2/products")).json())
            for path in (
                f"/api/v2/products/{product_id}",
                f"/api/v2/products/{product_id}/history",
                f"/api/v2/prices/products/{product_id}",
            ):
                assert (await client.get(path)).status_code == 404, path
        assert await connection.fetchval(
            "SELECT withdrawn_by FROM v2_content_withdrawals "
            "WHERE kind='product' AND content_id=$1", product_id,
        ) == admin_id
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_recipe_withdrawal_and_stale_draft_rejection(isolated_db):
    config = isolated_db
    admin_id, token = await _admin_session(config)
    connection = await connect_v2(config)
    try:
        recipe_id = await connection.fetchval(
            "INSERT INTO v2_recipes"
            "(author_id,title,description,base_servings,steps) "
            "VALUES($1,'Reported recipe','',2,'[\"Mix\"]'::jsonb) RETURNING id",
            admin_id,
        )
        draft_id = await connection.fetchval(
            "INSERT INTO v2_product_drafts(author_id,data) "
            "VALUES($1,'{\"name\":\"Pending product\",\"brand\":\"CI\"}'::jsonb) RETURNING id",
            admin_id,
        )
        transport = httpx.ASGITransport(app=app, client=("192.0.2.7", 443))
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            client.cookies.set("pc_v2_session", token, path="/api/v2")
            listed = await client.get("/api/v2/recipes")
            assert listed.status_code == 200, listed.text
            assert listed.json()["total"] == 1
            stale = await client.post(
                f"/api/v2/products/drafts/{draft_id}/reject",
                json={"revision": 2},
            )
            assert stale.status_code == 409
            rejected = await client.post(
                f"/api/v2/products/drafts/{draft_id}/reject",
                json={"revision": 1},
            )
            assert rejected.status_code == 200, rejected.text
            assert rejected.json()["status"] == "rejected"
            assert (await client.post(
                f"/api/v2/products/drafts/{draft_id}/approve",
                json={"revision": 1},
            )).status_code == 404
            assert any(item["id"] == draft_id for item in (
                await client.get("/api/v2/products/drafts/mine")
            ).json())
            report = await client.post(
                "/api/v2/moderation/reports",
                json={"kind": "recipe", "content_id": recipe_id,
                      "reason": "Recette à retirer pour le test"},
            )
            assert report.status_code == 201, report.text
            withdrawn = await client.post(
                f"/api/v2/moderation/reports/{report.json()['id']}/resolve",
                json={"action": "withdraw"},
            )
            assert withdrawn.status_code == 200, withdrawn.text
            assert (await client.get(f"/api/v2/recipes/{recipe_id}")).status_code == 404
            assert (await client.get("/api/v2/recipes")).json()["total"] == 0
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_account_export_is_private_and_excludes_credentials(isolated_db):
    config = isolated_db
    admin_id, token = await _admin_session(config)
    connection = await connect_v2(config)
    try:
        other_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('other','other','secret-other-hash','visitor') RETURNING id"
        )
        for author_id, name in (
            (admin_id, "My private draft"),
            (other_id, "Other private draft"),
        ):
            await connection.execute(
                "INSERT INTO v2_product_drafts(author_id,data) VALUES($1,$2::jsonb)",
                author_id, json.dumps({"name": name, "brand": "CI"}),
            )
        transport = httpx.ASGITransport(app=app, client=("192.0.2.8", 443))
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            assert (await client.get("/api/v2/account/export")).status_code == 401
            client.cookies.set("pc_v2_session", token, path="/api/v2")
            response = await client.get("/api/v2/account/export")
            assert response.status_code == 200, response.text
            assert response.headers["cache-control"] == "no-store"
            payload = response.json()
            assert payload["account"]["id"] == admin_id
            assert [item["data"]["name"] for item in payload["product_drafts"]] == [
                "My private draft"
            ]
            assert "password_hash" not in response.text
            assert "secret-other-hash" not in response.text
            assert "Other private draft" not in response.text
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_api_pool_bounds_concurrent_connections(isolated_db, monkeypatch):
    from app.services import v2_db_pool

    await v2_db_pool.close_v2_pool()
    monkeypatch.setattr(v2_db_pool, "_POOL_SIZE", 2)
    first = await v2_db_pool.acquire_v2(isolated_db)
    second = await v2_db_pool.acquire_v2(isolated_db)
    waiting = asyncio.create_task(v2_db_pool.acquire_v2(isolated_db))
    try:
        await asyncio.sleep(0.1)
        assert not waiting.done()
        await first.close()
        third = await asyncio.wait_for(waiting, 2)
        assert await third.fetchval("SELECT 1") == 1
        await third.close()
    finally:
        if not waiting.done():
            waiting.cancel()
        await first.close()
        await second.close()
        await v2_db_pool.close_v2_pool()
