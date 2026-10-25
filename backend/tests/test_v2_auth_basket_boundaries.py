"""Origin login cap and basket account fences on disposable PostgreSQL."""

from __future__ import annotations

import hashlib
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
    keys = [
        hashlib.sha256(("login-origin:" + remote + ":").encode()).hexdigest(),
        *(hashlib.sha256(("login:" + remote + ":" + name).encode()).hexdigest()
          for name in names),
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
async def test_basket_rejects_client_bound_to_another_account(monkeypatch, isolated_config):
    config = isolated_config
    monkeypatch.setattr(auth, "_read_config", lambda: config)
    connection = await connect_v2(config)
    user_ids = []
    try:
        suffix = secrets.token_hex(4)
        for index in range(2):
            user_ids.append(await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES($1,$1,'test','visitor') RETURNING id",
                "basket_audit_" + suffix + str(index),
            ))
        token = secrets.token_urlsafe(32)
        await connection.execute(
            "INSERT INTO v2_sessions(token_hash,user_id,expires_at) "
            "VALUES($1,$2,now()+interval '1 hour')",
            hashlib.sha256(token.encode()).hexdigest(), user_ids[0],
        )
        transport = httpx.ASGITransport(app=app, client=("192.0.2.78", 1234))
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            client.cookies.set("pc_v2_session", token, path="/api/v2")
            wrong = {"X-V2-Basket-User-ID": str(user_ids[1])}
            assert (await client.get("/api/v2/basket", headers=wrong)).status_code == 409
            assert (await client.put(
                "/api/v2/basket", headers=wrong,
                json={"product_ids": [], "revision": 0},
            )).status_code == 409
            assert (await client.get(
                "/api/v2/basket",
                headers={"X-V2-Basket-User-ID": str(user_ids[0])},
            )).status_code == 200
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_user_baskets WHERE user_id=ANY($1::bigint[])",
                user_ids,
            ) == 0
    finally:
        if user_ids:
            await connection.execute(
                "DELETE FROM v2_users WHERE id=ANY($1::bigint[])", user_ids
            )
        await connection.close()
