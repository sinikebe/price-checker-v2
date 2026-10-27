"""Authentication limits and session boundaries on disposable PostgreSQL."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from app.api.v2 import auth
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


def _config():
    return json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())


@pytest_asyncio.fixture
async def isolated_config():
    base = _config()
    database = "v2_boundary_" + secrets.token_hex(5)
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
async def test_login_cap_is_shared_across_unknown_usernames_and_expired_rows_are_purged(
    monkeypatch, isolated_config,
):
    config = isolated_config
    monkeypatch.setattr(auth, "_read_config", lambda: config)
    monkeypatch.setattr(auth, "_LOGIN_ORIGIN_MAX", 3)
    suffix = secrets.token_hex(4)
    names = ["audit" + suffix + str(index) for index in range(5)]
    remote = "192.0.2.77"
    monkeypatch.setattr(auth, "_access_code", lambda: "ci-limit-key")
    keys = [
        hmac.new(b"ci-limit-key", ("login-origin:" + remote + ":").encode(),
                 hashlib.sha256).hexdigest(),
        *(hmac.new(b"ci-limit-key", ("login:" + remote + ":" + name).encode(),
                   hashlib.sha256).hexdigest() for name in names),
    ]
    connection = await connect_v2(config)
    try:
        transport = httpx.ASGITransport(app=app, client=(remote, 1234))
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            statuses = []
            for name in names[:4]:
                response = await client.post(
                    "/api/v2/auth/login",
                    json={"username": name, "password": "wrong-password"},
                )
                statuses.append(response.status_code)
            assert statuses == [401, 401, 401, 429]
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_auth_limits WHERE key=ANY($1::text[])", keys
            ) == 4
            await connection.execute(
                "UPDATE v2_auth_limits SET window_started_at=now()-interval '2 hours' "
                "WHERE key=$1", keys[1]
            )
            response = await client.post(
                "/api/v2/auth/login",
                json={"username": names[4], "password": "wrong-password"},
            )
            assert response.status_code == 429
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_auth_limits WHERE key=ANY($1::text[])", keys
            ) == 3
    finally:
        await connection.execute(
            "DELETE FROM v2_auth_limits WHERE key=ANY($1::text[])", keys
        )
        await connection.close()


@pytest.mark.asyncio
async def test_expired_sessions_are_purged_before_a_new_session(isolated_config):
    from fastapi import Response

    connection = await connect_v2(isolated_config)
    try:
        user_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('audit','audit','test','visitor') RETURNING id"
        )
        await connection.execute(
            "INSERT INTO v2_sessions(token_hash,user_id,expires_at) "
            "VALUES($1,$2,now()-interval '1 day')", "f" * 64, user_id
        )
        await auth._issue_session(connection, Response(), user_id)
        assert await connection.fetchval(
            "SELECT count(*) FROM v2_sessions WHERE expires_at <= now()"
        ) == 0
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_ephemeral_auth_rows_expire_without_new_logins(isolated_config):
    connection = await connect_v2(isolated_config)
    try:
        user_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('retention','retention','test','visitor') RETURNING id"
        )
        await connection.execute(
            "INSERT INTO v2_sessions(token_hash,user_id,expires_at) "
            "VALUES($1,$2,now()-interval '1 day'),"
            "($3,$2,now()+interval '1 day')",
            "a" * 64, user_id, "b" * 64,
        )
        await connection.execute(
            "INSERT INTO v2_auth_limits(key,window_started_at,attempts) "
            "VALUES($1,now()-interval '2 hours',1),($2,now(),1)",
            "old-retention", "live-retention",
        )
        await auth.purge_ephemeral_auth_data(connection)
        assert await connection.fetchval(
            "SELECT count(*) FROM v2_sessions WHERE user_id=$1", user_id
        ) == 1
        assert await connection.fetchval(
            "SELECT count(*) FROM v2_auth_limits"
        ) == 1
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_superseded_product_cannot_receive_or_update_a_draft(
    monkeypatch, isolated_config,
):
    from app.api.v2 import products

    monkeypatch.setattr(auth, "_read_config", lambda: isolated_config)
    connection = await connect_v2(isolated_config)
    try:
        author_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('audit','audit','test','admin') RETURNING id"
        )
        async def acting_user(_connection, _request):
            return {"id": author_id, "username": "audit", "role": "admin"}
        monkeypatch.setattr(products, "_current_user", acting_user)
        product_data = {
            "name": "Audit", "brand": "Test", "package": "Boîte",
            "quantity": "100 g",
        }
        old_id = await connection.fetchval(
            "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
            json.dumps(product_data),
        )
        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 1234))
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            first = await client.post(
                "/api/v2/products/drafts",
                json={"product_id": old_id, "data": product_data},
            )
            assert first.status_code == 201
            draft_id = first.json()["id"]
            current_id = await connection.fetchval(
                "INSERT INTO v2_products(data,predecessor_id) "
                "VALUES($1::jsonb,$2) RETURNING id",
                json.dumps(product_data), old_id,
            )
            old = await client.get(f"/api/v2/products/{old_id}")
            assert old.json()["successor_id"] == current_id
            draft = await client.get(f"/api/v2/products/drafts/{draft_id}")
            assert draft.json()["successor_id"] == current_id
            updated = await client.put(
                f"/api/v2/products/drafts/{draft_id}",
                json={"revision": 1, "data": product_data, "change_kind": "correction"},
            )
            assert updated.status_code == 409
            new = await client.post(
                "/api/v2/products/drafts",
                json={"product_id": old_id, "data": product_data},
            )
            assert new.status_code == 409
            discarded = await client.delete(f"/api/v2/products/drafts/{draft_id}")
            assert discarded.status_code == 200
            assert discarded.json() == {"deleted": True}
            assert (await client.get(
                f"/api/v2/products/drafts/{draft_id}"
            )).status_code == 404
    finally:
        await connection.close()
