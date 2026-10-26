"""Regression checks for approval review and post-bootstrap setup access."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

from app.api.v2 import auth, setup
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
