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
        revisions = ["a" * 40, "b" * 40]
        next_revision = 0
        async def fake_fetch(store_id, repository, private):
            nonlocal next_revision
            sha = revisions[next_revision]
            next_revision += 1
            folder = tmp_path / str(store_id) / "revisions" / sha
            entry = folder / "connectors/demo/entry.py"
            entry.parent.mkdir(parents=True)
            entry.write_text(
                "async def setup(connection): await connection.execute('CREATE TABLE IF NOT EXISTS v2_connectors.v2_demo_connector_state(id int)')\n"
                "async def enqueue(connection, product_id): return 'queued'\n"
                "async def process_one(): pass\n")
            item = {"id": "demo", "name": "Demo", "version": f"0.1.{next_revision}",
                    "changelog": [{"version": f"0.1.{next_revision}", "notes": ["Version tested."]}]}
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
            connection = await test_connect()
            try:
                assert await connection.fetchval("SELECT to_regclass('v2_connectors.v2_demo_connector_state')")
            finally:
                await connection.close()
            versions = await client.get("/api/v2/connector-stores/versions")
            assert versions.json()["connectors"][0]["changelog"][0]["version"] == "0.1.1"
            disable = await client.put(prefix, headers=write,
                json={"action": "disable", "expected_installed_commit": revisions[0]})
            assert disable.status_code == 200 and not disable.json()["stores"][0]["installations"][0]["enabled"]
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
            assert (await client.delete(prefix, headers=write)).status_code == 200
            assert (await client.get("/api/v2/connector-stores/versions")).json() == {"connectors": []}
            assert (await client.delete(f"/api/v2/connector-stores/{store_id}", headers=write)).status_code == 200
    finally:
        root = await connect_v2(base)
        try:
            await root.execute('DROP DATABASE "' + db_name + '" WITH (FORCE)')
        finally:
            await root.close()
