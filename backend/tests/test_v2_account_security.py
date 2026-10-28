"""Second-factor and bearer-token boundaries on disposable PostgreSQL."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

import httpx
import pyotp
import pytest
import pytest_asyncio

from app.api.v2 import auth, auth_security
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


@pytest_asyncio.fixture
async def isolated_config(monkeypatch):
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_security_" + secrets.token_hex(5)
    admin = await connect_v2(base)
    try:
        await admin.execute('CREATE DATABASE "' + database + '"')
    finally:
        await admin.close()
    config = {**base, "database": database}
    await migrate_v2(config)
    monkeypatch.setattr(auth, "_read_config", lambda: config)
    monkeypatch.setattr(auth, "_access_code", lambda: "test-installation-secret")
    monkeypatch.setattr(auth_security, "_access_code", lambda: "test-installation-secret")
    try:
        yield config
    finally:
        admin = await connect_v2(base)
        try:
            await admin.execute('DROP DATABASE "' + database + '" WITH (FORCE)')
        finally:
            await admin.close()


async def _account(config, role="visitor"):
    username = "user" + secrets.token_hex(4)
    connection = await connect_v2(config)
    try:
        identifier = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES($1,$1,$2,$3) RETURNING id",
            username, await auth._hash_password("test-password-123"), role,
        )
        return identifier, username
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_totp_recovery_codes_and_session_only_management(isolated_config):
    user_id, username = await _account(isolated_config)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://test") as browser:
        login = await browser.post("/api/v2/auth/login", json={
            "username": username, "password": "test-password-123",
        })
        assert login.status_code == 200
        previous_token = await browser.post("/api/v2/account/security/tokens", json={
            "label": "before 2FA", "password": "test-password-123",
        })
        assert previous_token.status_code == 201
        setup = await browser.post("/api/v2/account/security/mfa/setup", json={
            "password": "test-password-123",
        })
        assert setup.status_code == 200, setup.text
        seed = setup.json()["secret"]
        assert setup.json()["provisioning_uri"].startswith("otpauth://totp/")
        connection = await connect_v2(isolated_config)
        try:
            encrypted = await connection.fetchval(
                "SELECT secret_ciphertext FROM v2_mfa_credentials WHERE user_id=$1", user_id,
            )
            assert seed not in encrypted
            assert await connection.fetchval(
                "SELECT enabled_at IS NULL FROM v2_mfa_credentials WHERE user_id=$1", user_id,
            )
        finally:
            await connection.close()
        initial_code = pyotp.TOTP(seed).now()
        confirmed = await browser.post("/api/v2/account/security/mfa/confirm", json={
            "code": initial_code,
        })
        assert confirmed.status_code == 200, confirmed.text
        codes = confirmed.json()["recovery_codes"]
        async with httpx.AsyncClient(transport=transport, base_url="https://test",
                                     headers={"Authorization": "Bearer " + previous_token.json()["token"]}) as api:
            assert (await api.get("/api/v2/auth/status")).status_code == 401
        assert (await browser.request("DELETE", "/api/v2/account", json={
            "password": "test-password-123",
        })).status_code == 401
        assert len(codes) == len(set(codes)) == 8
        assert (await browser.get("/api/v2/account/security/mfa")).json() == {
            "enabled": True, "pending": False, "recovery_codes_remaining": 8,
        }
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as second:
            missing = await second.post("/api/v2/auth/login", json={
                "username": username, "password": "test-password-123",
            })
            assert missing.status_code == 401
            replay = await second.post("/api/v2/auth/login", json={
                "username": username, "password": "test-password-123",
                "second_factor": initial_code,
            })
            assert replay.status_code == 401
            recovered = await second.post("/api/v2/auth/login", json={
                "username": username, "password": "test-password-123",
                "second_factor": codes[0],
            })
            assert recovered.status_code == 200, recovered.text
            used_again = await second.post("/api/v2/auth/login", json={
                "username": username, "password": "test-password-123",
                "second_factor": codes[0],
            })
            assert used_again.status_code == 401
        assert (await browser.get("/api/v2/account/security/mfa")).json()[
            "recovery_codes_remaining"] == 7
        assert (await browser.post("/api/v2/account/security/mfa/disable", json={
            "password": "test-password-123", "second_factor": "wrong",
        })).status_code == 401
        regenerated = await browser.post("/api/v2/account/security/mfa/recovery-codes", json={
            "password": "test-password-123", "second_factor": codes[1],
        })
        assert regenerated.status_code == 200
        assert len(regenerated.json()["recovery_codes"]) == 8
        assert (await browser.get("/api/v2/account/security/mfa")).json()[
            "recovery_codes_remaining"] == 8
        disabled = await browser.post("/api/v2/account/security/mfa/disable", json={
            "password": "test-password-123",
            "second_factor": regenerated.json()["recovery_codes"][0],
        })
        assert disabled.status_code == 204, disabled.text
        assert (await browser.get("/api/v2/account/security/mfa")).json()["enabled"] is False
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as third:
            assert (await third.post("/api/v2/auth/login", json={
                "username": username, "password": "test-password-123",
            })).status_code == 200


@pytest.mark.asyncio
async def test_personal_tokens_scopes_revocation_and_admin_boundary(isolated_config):
    admin_id, username = await _account(isolated_config, "admin")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://test") as browser:
        assert (await browser.post("/api/v2/auth/login", json={
            "username": username, "password": "test-password-123",
        })).status_code == 200
        create = await browser.post("/api/v2/account/security/tokens", json={
            "label": "read client", "scope": "read", "expires_in_days": 30,
            "password": "test-password-123",
        })
        assert create.status_code == 201, create.text
        token = create.json()["token"]
        assert token.startswith("pcv2_")
        listed = await browser.get("/api/v2/account/security/tokens")
        assert listed.status_code == 200
        assert token not in listed.text
        connection = await connect_v2(isolated_config)
        try:
            row = await connection.fetchrow(
                "SELECT token_hash,user_id FROM v2_api_tokens WHERE id=$1", create.json()["id"],
            )
            assert row["user_id"] == admin_id
            assert row["token_hash"] != token
        finally:
            await connection.close()
        async with httpx.AsyncClient(transport=transport, base_url="https://test",
                                     headers={"Authorization": "Bearer " + token}) as api:
            state = await api.get("/api/v2/auth/status")
            assert state.status_code == 200
            assert state.json()["user"]["role"] == "visitor"
            assert (await api.get("/api/v2/auth/token")).json()["scope"] == "read"
            assert (await api.get("/api/v2/setup/hostname")).status_code == 403
            assert (await api.get("/api/v2/account/security/tokens")).status_code == 403
            assert (await api.post("/api/v2/moderation/reports", json={
                "kind": "product", "content_id": 1, "reason": "A report with enough detail",
            })).status_code == 403
            assert (await api.request("DELETE", "/api/v2/account", json={
                "password": "test-password-123",
            })).status_code == 403
        contribute = await browser.post("/api/v2/account/security/tokens", json={
            "label": "contributor", "scope": "contribute", "password": "test-password-123",
        })
        assert contribute.status_code == 201
        async with httpx.AsyncClient(transport=transport, base_url="https://test",
                                     headers={"Authorization": "Bearer " + contribute.json()["token"]}) as api:
            draft = await api.post("/api/v2/products/drafts", json={
                "data": {"name": "API product", "brand": "Test", "package": "Boîte", "quantity": "100 g"},
            })
            assert draft.status_code == 201, draft.text
            assert (await api.get("/api/v2/setup/hostname")).status_code == 403
        assert (await browser.delete(
            "/api/v2/account/security/tokens/" + str(create.json()["id"])
        )).status_code == 204
        async with httpx.AsyncClient(transport=transport, base_url="https://test",
                                     headers={"Authorization": "Bearer " + token}) as api:
            assert (await api.get("/api/v2/auth/status")).status_code == 401
        connection = await connect_v2(isolated_config)
        try:
            await connection.execute(
                "UPDATE v2_api_tokens SET expires_at=now()-interval '1 second' "
                "WHERE id=$1", contribute.json()["id"],
            )
        finally:
            await connection.close()
        async with httpx.AsyncClient(transport=transport, base_url="https://test",
                                     headers={"Authorization": "Bearer " + contribute.json()["token"]}) as api:
            assert (await api.get("/api/v2/auth/status")).status_code == 401
        # An invalid Authorization header cannot fall back to a valid cookie.
        assert (await browser.get("/api/v2/auth/status", headers={
            "Authorization": "Bearer invalid",
        })).status_code == 401


@pytest.mark.asyncio
async def test_concurrent_totp_logins_consume_one_step_only(isolated_config, monkeypatch):
    import asyncio
    from types import SimpleNamespace

    user_id, username = await _account(isolated_config)
    seed = pyotp.random_base32()
    step = 1_900_000_000 // 30
    monkeypatch.setattr(auth_security, "time", SimpleNamespace(time=lambda: step * 30))
    connection = await connect_v2(isolated_config)
    try:
        await connection.execute(
            "INSERT INTO v2_mfa_credentials(user_id,secret_ciphertext,enabled_at,last_step) "
            "VALUES($1,$2,now(),$3)",
            user_id, auth_security.encrypt_seed(seed), step - 1,
        )
    finally:
        await connection.close()
    code = pyotp.TOTP(seed).at(step * 30)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://test") as first, \
               httpx.AsyncClient(transport=transport, base_url="https://test") as second:
        async def attempt(client):
            return await client.post("/api/v2/auth/login", json={
                "username": username, "password": "test-password-123",
                "second_factor": code,
            })
        results = await asyncio.gather(attempt(first), attempt(second))
    assert sorted(response.status_code for response in results) == [200, 401]


@pytest.mark.asyncio
async def test_second_factor_limits_apply_across_source_addresses(isolated_config):
    user_id, username = await _account(isolated_config)
    connection = await connect_v2(isolated_config)
    try:
        await connection.execute(
            "INSERT INTO v2_mfa_credentials(user_id,secret_ciphertext,enabled_at) "
            "VALUES($1,$2,now())", user_id,
            auth_security.encrypt_seed(pyotp.random_base32()),
        )
        await connection.execute(
            "INSERT INTO v2_auth_limits(key,attempts) VALUES($1,20)",
            auth_security.account_limit_key("mfa-login", user_id),
        )
    finally:
        await connection.close()
    transport = httpx.ASGITransport(app=app, client=("198.51.100.12", 9876))
    async with httpx.AsyncClient(transport=transport, base_url="https://test") as browser:
        response = await browser.post("/api/v2/auth/login", json={
            "username": username, "password": "test-password-123", "second_factor": "000000",
        })
        assert response.status_code == 429


@pytest.mark.asyncio
async def test_login_started_before_enrollment_must_recheck_factor(isolated_config, monkeypatch):
    import asyncio

    user_id, username = await _account(isolated_config)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://test") as enrolled, \
               httpx.AsyncClient(transport=transport, base_url="https://test") as racing:
        assert (await enrolled.post("/api/v2/auth/login", json={
            "username": username, "password": "test-password-123",
        })).status_code == 200
        setup = await enrolled.post("/api/v2/account/security/mfa/setup", json={
            "password": "test-password-123",
        })
        assert setup.status_code == 200
        checked = asyncio.Event()
        resume = asyncio.Event()
        original = auth._verify_password

        async def pause_after_password(encoded, password):
            result = await original(encoded, password)
            checked.set()
            await asyncio.wait_for(resume.wait(), 5)
            return result

        monkeypatch.setattr(auth, "_verify_password", pause_after_password)
        pending = asyncio.create_task(racing.post("/api/v2/auth/login", json={
            "username": username, "password": "test-password-123",
        }))
        try:
            await asyncio.wait_for(checked.wait(), 5)
            confirmed = await enrolled.post("/api/v2/account/security/mfa/confirm", json={
                "code": pyotp.TOTP(setup.json()["secret"]).now(),
            })
            assert confirmed.status_code == 200
        finally:
            resume.set()
        assert (await asyncio.wait_for(pending, 5)).status_code == 401
        connection = await connect_v2(isolated_config)
        try:
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_sessions WHERE user_id=$1", user_id,
            ) == 1
        finally:
            await connection.close()


@pytest.mark.asyncio
async def test_account_deletion_attempts_are_limited_across_addresses(isolated_config):
    user_id, username = await _account(isolated_config)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://test") as browser:
        assert (await browser.post("/api/v2/auth/login", json={
            "username": username, "password": "test-password-123",
        })).status_code == 200
        connection = await connect_v2(isolated_config)
        try:
            await connection.execute(
                "INSERT INTO v2_auth_limits(key,attempts) VALUES($1,5)",
                auth_security.account_limit_key("account-delete", user_id),
            )
        finally:
            await connection.close()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, client=("203.0.113.9", 1234)),
            base_url="https://test", cookies=browser.cookies,
        ) as alternate:
            denied = await alternate.request("DELETE", "/api/v2/account", json={
                "password": "test-password-123",
            })
            assert denied.status_code == 429
        connection = await connect_v2(isolated_config)
        try:
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_users WHERE id=$1", user_id,
            ) == 1
        finally:
            await connection.close()


@pytest.mark.asyncio
async def test_enrollment_revokes_login_issued_while_it_waited(isolated_config, monkeypatch):
    import asyncio

    _, username = await _account(isolated_config)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://test") as enrolled, \
               httpx.AsyncClient(transport=transport, base_url="https://test") as racing:
        assert (await enrolled.post("/api/v2/auth/login", json={
            "username": username, "password": "test-password-123",
        })).status_code == 200
        setup = await enrolled.post("/api/v2/account/security/mfa/setup", json={
            "password": "test-password-123",
        })
        assert setup.status_code == 200
        issuing = asyncio.Event()
        resume = asyncio.Event()
        original = auth._issue_session

        async def pause_before_session(connection, response, user_id):
            issuing.set()
            await asyncio.wait_for(resume.wait(), 5)
            await original(connection, response, user_id)

        monkeypatch.setattr(auth, "_issue_session", pause_before_session)
        login_task = asyncio.create_task(racing.post("/api/v2/auth/login", json={
            "username": username, "password": "test-password-123",
        }))
        await asyncio.wait_for(issuing.wait(), 5)
        confirm_task = asyncio.create_task(enrolled.post(
            "/api/v2/account/security/mfa/confirm", json={
                "code": pyotp.TOTP(setup.json()["secret"]).now(),
            },
        ))
        try:
            await asyncio.sleep(0.05)
            assert not confirm_task.done()
        finally:
            resume.set()
        assert (await asyncio.wait_for(login_task, 5)).status_code == 200
        assert (await asyncio.wait_for(confirm_task, 5)).status_code == 200
        assert (await racing.get("/api/v2/auth/status")).json()["user"] is None
