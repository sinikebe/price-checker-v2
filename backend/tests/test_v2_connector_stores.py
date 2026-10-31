"""A store is only metadata until an administrator installs a pinned revision."""
import hashlib
import json
import os
import secrets
from pathlib import Path

import httpx
import pytest

from app.services.v2_connector_stores import repository_url, validate_catalog


def test_repository_is_github_only():
    assert repository_url("https://github.com/example/store")[0] == "https://github.com/example/store.git"
    for value in ("http://github.com/example/store", "https://example.com/example/store",
                  "https://github.com/example/store?x=1", "file:///etc/passwd",
                  "https://github.com/example/store;touch /tmp/a"):
        with pytest.raises(ValueError):
            repository_url(value)


def test_catalogue_requires_numeric_changelog_and_does_not_import_code(tmp_path):
    code = tmp_path / "connectors/demo/entry.py"
    code.parent.mkdir(parents=True)
    code.write_text("raise RuntimeError('must not execute during discovery')\n")
    manifest = tmp_path / "connector-store.json"
    item = {"id": "demo", "name": "Demo", "version": "0.1.0",
            "changelog": [{"version": "0.1.0", "notes": ["Initial version."]}]}
    manifest.write_text(json.dumps({"api": 1, "connectors": [item]}))
    assert validate_catalog(tmp_path)[0]["version"] == "0.1.0"
    item["changelog"] = []
    manifest.write_text(json.dumps({"api": 1, "connectors": [item]}))
    with pytest.raises(ValueError, match="Journal"):
        validate_catalog(tmp_path)
    item["changelog"] = [{"version": "0.1.0", "notes": ["Initial version."]}]
    code.unlink()
    code.symlink_to(tmp_path / "connector-store.json")
    manifest.write_text(json.dumps({"api": 1, "connectors": [item]}))
    with pytest.raises(ValueError, match="Code"):
        validate_catalog(tmp_path)


@pytest.mark.asyncio
async def test_admin_store_install_disable_update_remove_and_public_versions(monkeypatch, tmp_path):
    from app.api.v2 import auth, connector_stores as api
    from app.db.v2_migrations import connect_v2, migrate_v2
    from app.main_v2 import app
    from app.services import v2_connector_stores as service

    config_path = os.getenv("V2_AUTH_TEST_CONFIG")
    if not config_path:
        pytest.skip("Disposable PostgreSQL required")
    base = json.loads(Path(config_path).read_text())
    assert base["database"] not in {"pricechecker_v2_dev", "pricechecker_v2_prod"}
    db_name = "pcv2_store_case_" + secrets.token_hex(5)
    root = await connect_v2(base)
    try:
        await root.execute('CREATE DATABASE "' + db_name + '"')
    finally:
        await root.close()
    config = {**base, "database": db_name}
    try:
        await migrate_v2(config)
        async def test_connect():
            return await connect_v2(config)
        monkeypatch.setattr(auth, "_connect", test_connect)
        monkeypatch.setattr(api, "_connect", test_connect)
        monkeypatch.setattr(api, "store_dir", lambda identifier: tmp_path / str(identifier))
        monkeypatch.setattr(service, "store_dir", lambda identifier: tmp_path / str(identifier))
        connection = await connect_v2(config)
        try:
            admin_id = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES('admin','admin','test','admin') RETURNING id")
            token = secrets.token_urlsafe(32)
            await connection.execute(
                "INSERT INTO v2_sessions(token_hash,user_id,expires_at) "
                "VALUES($1,$2,now()+interval '1 hour')",
                hashlib.sha256(token.encode()).hexdigest(), admin_id)
        finally:
            await connection.close()
        revisions = ["a" * 40, "b" * 40, "c" * 40]
        next_revision = 0
        async def fake_fetch(store_id, repository, private):
            nonlocal next_revision
            sha = revisions[next_revision]
            next_revision += 1
            folder = tmp_path / str(store_id) / "revisions" / sha
            entry = folder / "connectors/demo/entry.py"
            entry.parent.mkdir(parents=True)
            entry.write_text(
                "async def setup(connection):\n"
                " await connection.execute('CREATE TABLE IF NOT EXISTS v2_connectors.v2_demo_connector_state(resumed boolean NOT NULL DEFAULT false)')\n"
                " await connection.execute('INSERT INTO v2_connectors.v2_demo_connector_state(resumed) SELECT false WHERE NOT EXISTS(SELECT 1 FROM v2_connectors.v2_demo_connector_state)')\n"
                "async def resume(connection): await connection.execute('UPDATE v2_connectors.v2_demo_connector_state SET resumed=true')\n"
                "async def settings_read(connection):\n"
                " row = await connection.fetchrow('SELECT resumed FROM v2_connectors.v2_demo_connector_state')\n"
                " return {'revision': int(row['resumed']), 'fields': [{'key': 'resumed', 'label': 'Enabled', 'type': 'boolean'}], 'values': {'resumed': row['resumed']}}\n"
                "async def settings_write(connection, expected_revision, values):\n"
                " from fastapi import HTTPException\n"
                " row = await connection.fetchrow('SELECT resumed FROM v2_connectors.v2_demo_connector_state FOR UPDATE')\n"
                " if expected_revision != int(row['resumed']): raise HTTPException(status_code=409, detail='Stale settings')\n"
                " if set(values) != {'resumed'} or type(values['resumed']) is not bool: raise ValueError('Invalid settings')\n"
                " await connection.execute('UPDATE v2_connectors.v2_demo_connector_state SET resumed=$1', values['resumed'])\n"
                "async def enqueue(connection, product_id): return 'queued'\n"
                "async def enqueue_basket(connection, product_id): return 'priority_queued'\n"
                "async def process_one(): pass\n")
            item = {"id": "demo", "name": "Demo", "version": f"0.1.{next_revision}",
                    "changelog": [{"version": f"0.1.{next_revision}", "notes": ["Version tested."]}],
                    "rollback_supported": next_revision < 3}
            (folder / "connector-store.json").write_text(json.dumps({"api": 1, "connectors": [item]}))
            return sha, validate_catalog(folder)
        monkeypatch.setattr(api, "fetch_store", fake_fetch)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="https://testserver") as client:
            write = {"origin": "https://testserver"}
            assert (await client.get("/api/v2/connector-stores")).status_code == 403
            client.cookies.set("pc_v2_session", token)
            add = await client.post("/api/v2/connector-stores", headers=write,
                json={"name": "Test", "repository": "https://github.com/example/store", "private": False})
            assert add.status_code == 201, add.text
            store_id = add.json()["stores"][0]["id"]
            assert (await client.post(f"/api/v2/connector-stores/{store_id}/refresh", headers=write)).status_code == 200
            prefix = f"/api/v2/connector-stores/{store_id}/connectors/demo"
            install = await client.put(prefix, headers=write,
                json={"action": "install", "expected_commit": revisions[0]})
            assert install.status_code == 200, install.text
            assert install.json()["stores"][0]["installations"][0]["commit_sha"] == revisions[0]
            settings_url = prefix + "/settings"
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="https://testserver"
            ) as anonymous:
                assert (await anonymous.get(settings_url)).status_code == 403
                assert (
                    await anonymous.put(
                        settings_url,
                        headers=write,
                        json={"expected_revision": 0, "values": {"resumed": True}},
                    )
                ).status_code == 403
            initial_settings = await client.get(settings_url)
            assert initial_settings.status_code == 200
            assert initial_settings.json()["values"] == {"resumed": False}
            invalid_settings = await client.put(
                settings_url,
                headers=write,
                json={"expected_revision": 0, "values": {"resumed": 4}},
            )
            assert invalid_settings.status_code == 422
            changed_settings = await client.put(
                settings_url,
                headers=write,
                json={"expected_revision": 0, "values": {"resumed": True}},
            )
            assert changed_settings.status_code == 200
            assert changed_settings.json()["values"] == {"resumed": True}
            assert (
                await client.put(
                    settings_url,
                    headers=write,
                    json={"expected_revision": 0, "values": {"resumed": False}},
                )
            ).status_code == 409
            connection = await test_connect()
            try:
                assert await connection.fetchval("SELECT to_regclass('v2_connectors.v2_demo_connector_state')")
            finally:
                await connection.close()
            versions = await client.get("/api/v2/connector-stores/versions")
            assert versions.json()["connectors"][0]["changelog"][0]["version"] == "0.1.1"
            basket_url = "/api/v2/connector-stores/demo/products/refresh"
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, client=("10.0.0.9", 12345)),
                base_url="https://testserver",
            ) as shopper:
                basket = await shopper.post(
                    basket_url, headers=write, json={"product_ids": [1, 2, 1]})
                assert basket.status_code == 200, basket.text
                assert basket.json() == {"products": {"1": "priority_queued", "2": "priority_queued"}}
                assert (await shopper.post(
                    basket_url, headers=write, json={"product_ids": [0]})
                ).status_code == 422
                assert (await shopper.post(
                    basket_url, headers=write, json={"product_ids": list(range(1, 52))})
                ).status_code == 422
                # The budget counts products, not requests. Two are spent, so of the
                # next batch only the products that still fit are admitted, in order.
                limit = api.CLIENT_REFRESH_REQUESTS_PER_HOUR
                rest = list(range(3, 3 + limit))
                partial = await shopper.post(basket_url, headers=write, json={"product_ids": rest})
                assert partial.status_code == 200, partial.text
                assert partial.json() == {"products": {
                    str(product_id): "priority_queued" if index < limit - 2 else "rate_limited"
                    for index, product_id in enumerate(rest)}}
                assert (await shopper.post(
                    basket_url, headers=write, json={"product_ids": [limit + 3]})
                ).status_code == 429
            connection = await test_connect()
            try:
                # One unit of each budget per admitted product; refused ones are not charged.
                assert await connection.fetchval(
                    "SELECT sum(attempts) FROM v2_auth_limits") == 2 * limit
                await connection.execute("DELETE FROM v2_auth_limits")
            finally:
                await connection.close()
            # The shared budget is spent across clients, by batches too.
            for index in range(api.REFRESH_REQUESTS_PER_HOUR // limit):
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app, client=(f"10.0.1.{index}", 12345)),
                    base_url="https://testserver",
                ) as shopper:
                    full = await shopper.post(
                        basket_url, headers=write, json={"product_ids": list(range(1, limit + 1))})
                    assert set(full.json()["products"].values()) == {"priority_queued"}
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, client=("10.0.1.99", 12345)),
                base_url="https://testserver",
            ) as shopper:
                assert (await shopper.post(
                    basket_url, headers=write, json={"product_ids": [1]})).status_code == 429
            connection = await test_connect()
            try:
                await connection.execute("DELETE FROM v2_auth_limits")
            finally:
                await connection.close()
            # Basket refresh is intentionally anonymous, but neither one
            # client nor many clients may create unbounded collector demand.
            refresh_url = "/api/v2/connector-stores/demo/products/1/refresh"
            for address in ("10.0.0.1", "10.0.0.2"):
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app, client=(address, 12345)),
                    base_url="https://testserver",
                ) as shopper:
                    for _ in range(api.CLIENT_REFRESH_REQUESTS_PER_HOUR):
                        response = await shopper.post(refresh_url, headers=write)
                        assert response.status_code == 200, response.text
                        assert response.json() == {"status": "queued"}
                    assert (await shopper.post(refresh_url, headers=write)).status_code == 429
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, client=("10.0.0.3", 12345)),
                base_url="https://testserver",
            ) as shopper:
                assert (await shopper.post(refresh_url, headers=write)).status_code == 429
            connection = await test_connect()
            try:
                await connection.execute("DELETE FROM v2_auth_limits")
            finally:
                await connection.close()
            original_enqueue = api.enqueue_installed

            async def broken_enqueue(*_args):
                raise RuntimeError("Simulated connector failure")

            monkeypatch.setattr(api, "enqueue_installed", broken_enqueue)
            try:
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(
                        app=app, client=("10.0.0.4", 12345), raise_app_exceptions=False),
                    base_url="https://testserver",
                ) as shopper:
                    for _ in range(api.CLIENT_REFRESH_REQUESTS_PER_HOUR):
                        assert (await shopper.post(refresh_url, headers=write)).status_code == 500
                    assert (await shopper.post(refresh_url, headers=write)).status_code == 429
            finally:
                monkeypatch.setattr(api, "enqueue_installed", original_enqueue)
            connection = await test_connect()
            try:
                assert await connection.fetchval(
                    "SELECT sum(attempts) FROM v2_auth_limits") == 2 * api.CLIENT_REFRESH_REQUESTS_PER_HOUR
            finally:
                await connection.close()
            disable = await client.put(prefix, headers=write,
                json={"action": "disable", "expected_installed_commit": revisions[0]})
            assert disable.status_code == 200 and not disable.json()["stores"][0]["installations"][0]["enabled"]
            enable = await client.put(prefix, headers=write,
                json={"action": "enable", "expected_installed_commit": revisions[0]})
            assert enable.status_code == 200 and enable.json()["stores"][0]["installations"][0]["enabled"]
            connection = await test_connect()
            try:
                assert await connection.fetchval(
                    "SELECT resumed FROM v2_connectors.v2_demo_connector_state")
            finally:
                await connection.close()
            assert (await client.post(f"/api/v2/connector-stores/{store_id}/refresh", headers=write)).status_code == 200
            stale = await client.put(prefix, headers=write,
                json={"action": "update", "expected_commit": revisions[0],
                      "expected_installed_commit": revisions[0]})
            assert stale.status_code == 409
            update = await client.put(prefix, headers=write,
                json={"action": "update", "expected_commit": revisions[1],
                      "expected_installed_commit": revisions[0]})
            assert update.status_code == 200, update.text
            assert update.json()["stores"][0]["installations"][0]["commit_sha"] == revisions[1]
            rollback = await client.put(prefix, headers=write,
                json={"action": "rollback", "expected_installed_commit": revisions[1]})
            assert rollback.status_code == 200, rollback.text
            assert rollback.json()["stores"][0]["installations"][0]["commit_sha"] == revisions[0]
            assert (await client.post(f"/api/v2/connector-stores/{store_id}/refresh", headers=write)).status_code == 200
            incompatible = await client.put(prefix, headers=write,
                json={"action": "update", "expected_commit": revisions[2],
                      "expected_installed_commit": revisions[0]})
            assert incompatible.status_code == 200, incompatible.text
            assert incompatible.json()["stores"][0]["installations"][0]["previous_commit"] is None
            assert (await client.put(prefix, headers=write,
                json={"action": "rollback", "expected_installed_commit": revisions[2]})).status_code == 409
            assert (await client.delete(prefix, headers=write)).status_code == 200
            assert (await client.get("/api/v2/connector-stores/versions")).json() == {"connectors": []}
            assert (await client.delete(f"/api/v2/connector-stores/{store_id}", headers=write)).status_code == 200
    finally:
        root = await connect_v2(base)
        try:
            await root.execute('DROP DATABASE "' + db_name + '" WITH (FORCE)')
        finally:
            await root.close()
