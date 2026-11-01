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
                " await connection.execute('CREATE TABLE IF NOT EXISTS v2_connectors.v2_demo_connector_state(resumed boolean NOT NULL DEFAULT false, resume_calls integer NOT NULL DEFAULT 0)')\n"
                " await connection.execute('INSERT INTO v2_connectors.v2_demo_connector_state(resumed) SELECT false WHERE NOT EXISTS(SELECT 1 FROM v2_connectors.v2_demo_connector_state)')\n"
                "async def resume(connection): await connection.execute('UPDATE v2_connectors.v2_demo_connector_state SET resume_calls=resume_calls+1')\n"
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
                "async def product_statuses(connection, product_ids):\n"
                " return {str(product_id): {'status': 'eligible' if product_id == 1 else 'unmapped_product', 'rank': None, 'store_name': 'Test'} for product_id in product_ids}\n"
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
            page_url = "/api/v2/connector-stores/demo/products/page-refresh"
            status_url = "/api/v2/connector-stores/demo/products/status"
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, client=("10.0.0.8", 12345)),
                base_url="https://testserver",
            ) as page_viewer:
                state = await page_viewer.post(status_url, headers=write, json={"product_ids": [1, 2]})
                assert state.status_code == 200, state.text
                assert state.json()["products"]["1"]["status"] == "eligible"
                page = await page_viewer.post(page_url, headers=write, json={"product_ids": [1, 2]})
                assert page.status_code == 200, page.text
                assert page.json()["products"]["1"]["status"] == "queued"
                assert page.json()["products"]["2"]["status"] == "unmapped_product"
                assert (await page_viewer.post(page_url, headers=write, json={"product_ids": [0]})).status_code == 422
            connection = await test_connect()
            try:
                assert await connection.fetchval("SELECT sum(attempts) FROM v2_auth_limits") == 2
                await connection.execute("DELETE FROM v2_auth_limits")
            finally:
                await connection.close()
            # Price pages draw on their own budgets: spending them never reduces a basket's.
            basket_path = "/api/v2/connector-stores/demo/products/refresh"
            page_limit = api.CLIENT_PAGE_REFRESH_REQUESTS_PER_HOUR
            assert api.PAGE_REFRESH_REQUESTS_PER_HOUR == 2 * page_limit
            async def page_client(address):
                return httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app, client=(address, 12345)),
                    base_url="https://testserver")
            async with await page_client("10.0.2.1") as visitor:
                for _ in range(page_limit):
                    queued = await visitor.post(page_url, headers=write, json={"product_ids": [1]})
                    assert queued.json()["products"]["1"]["status"] == "queued", queued.text
                throttled = await visitor.post(page_url, headers=write, json={"product_ids": [1]})
                assert throttled.status_code == 200, throttled.text
                assert throttled.json()["products"]["1"]["status"] == "rate_limited"
                basket = await visitor.post(basket_path, headers=write, json={"product_ids": [1]})
                assert basket.json() == {"products": {"1": "priority_queued"}}
            async with await page_client("10.0.2.2") as visitor:
                for _ in range(page_limit):
                    queued = await visitor.post(page_url, headers=write, json={"product_ids": [1]})
                    assert queued.json()["products"]["1"]["status"] == "queued", queued.text
            # The shared page budget is now spent for every client, and still leaves baskets alone.
            async with await page_client("10.0.2.3") as visitor:
                throttled = await visitor.post(page_url, headers=write, json={"product_ids": [1]})
                assert throttled.json()["products"]["1"]["status"] == "rate_limited"
                basket = await visitor.post(basket_path, headers=write, json={"product_ids": [1]})
                assert basket.json() == {"products": {"1": "priority_queued"}}
            connection = await test_connect()
            try:
                await connection.execute("DELETE FROM v2_auth_limits")
            finally:
                await connection.close()
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
                # One resume from the fresh installation, one from enabling it again.
                assert await connection.fetchval(
                    "SELECT resume_calls FROM v2_connectors.v2_demo_connector_state") == 2
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


class _Installed:
    """The only database access of `page_product_statuses` is one installation lookup."""

    def __init__(self, row):
        self.row = row

    async def fetchrow(self, *_args):
        return self.row


def _module(monkeypatch, **hooks):
    from types import SimpleNamespace

    from app.api.v2 import connector_stores as api

    monkeypatch.setattr(api, "load_installed", lambda *_args: SimpleNamespace(**hooks))
    return api, _Installed({"store_id": 1, "commit_sha": "a" * 40})


@pytest.mark.asyncio
async def test_page_status_without_enabled_installation_is_disabled():
    from app.api.v2 import connector_stores as api

    result = await api.page_product_statuses(_Installed(None), "demo", [1, 2])
    assert result == {"1": {"status": "disabled", "rank": None}, "2": {"status": "disabled", "rank": None}}


@pytest.mark.asyncio
async def test_page_status_without_hook_is_unsupported(monkeypatch):
    api, connection = _module(monkeypatch)
    assert await api.page_product_statuses(connection, "demo", [1]) == {
        "1": {"status": "unsupported", "rank": None}}


@pytest.mark.asyncio
async def test_page_status_passes_through_a_valid_answer(monkeypatch):
    async def product_statuses(_connection, ids):
        return {str(i): {"status": "queued", "rank": 3, "store_name": "Magasin"} for i in ids}
    api, connection = _module(monkeypatch, product_statuses=product_statuses)
    assert await api.page_product_statuses(connection, "demo", [7]) == {
        "7": {"status": "queued", "rank": 3, "store_name": "Magasin"}}


@pytest.mark.asyncio
async def test_page_status_degrades_when_the_connector_hook_fails(monkeypatch):
    async def product_statuses(_connection, _ids):
        raise RuntimeError("connector bug")
    api, connection = _module(monkeypatch, product_statuses=product_statuses)
    assert await api.page_product_statuses(connection, "demo", [1, 2]) == {
        "1": {"status": "unavailable", "rank": None}, "2": {"status": "unavailable", "rank": None}}


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", [
    [],  # not a mapping
    {},  # requested product missing
    {"1": {"rank": None}},  # no status
    {"1": {"status": "queued", "rank": 0}},  # rank must be positive
    {"1": {"status": "queued", "rank": True}},  # a boolean is not a rank
    {"1": {"status": "queued", "rank": None, "store_name": "x" * 201}},  # name too long
])
async def test_page_status_rejects_a_malformed_answer(monkeypatch, answer):
    from fastapi import HTTPException

    async def product_statuses(_connection, _ids):
        return answer
    api, connection = _module(monkeypatch, product_statuses=product_statuses)
    with pytest.raises(HTTPException) as refused:
        await api.page_product_statuses(connection, "demo", [1])
    assert refused.value.status_code == 503


@pytest.mark.asyncio
async def test_connector_hook_errors_are_reported_and_nothing_is_installed(monkeypatch, tmp_path):
    """A connector's setup/resume failure is explained to the administrator and leaves no installation."""
    from app.api.v2 import auth, connector_stores as api
    from app.db.v2_migrations import connect_v2, migrate_v2
    from app.main_v2 import app
    from app.services import v2_connector_stores as service

    config_path = os.getenv("V2_AUTH_TEST_CONFIG")
    if not config_path:
        pytest.skip("Disposable PostgreSQL required")
    base = json.loads(Path(config_path).read_text())
    assert base["database"] not in {"pricechecker_v2_dev", "pricechecker_v2_prod"}
    db_name = "pcv2_store_hooks_" + secrets.token_hex(5)
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

        state = ("CREATE TABLE IF NOT EXISTS v2_connectors.v2_hooks_state(resume_calls integer NOT NULL DEFAULT 0);"
                 " INSERT INTO v2_connectors.v2_hooks_state SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM v2_connectors.v2_hooks_state)")
        modules = [
            # 0: setup refuses with a message meant for the administrator
            "async def setup(connection): raise ValueError('Magasin ambigu : fusionnez les doublons.')\n"
            "async def enqueue(connection, product_id): return 'queued'\nasync def process_one(): pass\n",
            # 1: setup fails for an unexpected reason whose details must not reach the browser
            "async def setup(connection): raise RuntimeError('secret internal detail')\n"
            "async def enqueue(connection, product_id): return 'queued'\nasync def process_one(): pass\n",
            # 2: resume refuses on installation
            f"async def setup(connection): await connection.execute(\"{state}\")\n"
            "async def resume(connection): raise ValueError('Boutique supprimée.')\n"
            "async def enqueue(connection, product_id): return 'queued'\nasync def process_one(): pass\n",
            # 3: a working connector that remembers it was resumed
            f"async def setup(connection): await connection.execute(\"{state}\")\n"
            "async def resume(connection): await connection.execute('UPDATE v2_connectors.v2_hooks_state SET resume_calls=resume_calls+1')\n"
            "async def enqueue(connection, product_id): return 'queued'\nasync def process_one(): pass\n",
        ]
        shas = [chr(ord("a") + index) * 40 for index in range(len(modules))]
        fetched = 0

        async def fake_fetch(store_id, repository, private):
            nonlocal fetched
            sha, source = shas[fetched], modules[fetched]
            fetched += 1
            folder = tmp_path / str(store_id) / "revisions" / sha
            entry = folder / "connectors/hooks/entry.py"
            entry.parent.mkdir(parents=True)
            entry.write_text(source)
            item = {"id": "hooks", "name": "Hooks", "version": "0.1.0",
                    "changelog": [{"version": "0.1.0", "notes": ["Version tested."]}]}
            (folder / "connector-store.json").write_text(json.dumps({"api": 1, "connectors": [item]}))
            return sha, validate_catalog(folder)
        monkeypatch.setattr(api, "fetch_store", fake_fetch)

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="https://testserver") as client:
            write = {"origin": "https://testserver"}
            client.cookies.set("pc_v2_session", token)
            add = await client.post("/api/v2/connector-stores", headers=write,
                json={"name": "Test", "repository": "https://github.com/example/store", "private": False})
            assert add.status_code == 201, add.text
            store_id = add.json()["stores"][0]["id"]
            prefix = f"/api/v2/connector-stores/{store_id}/connectors/hooks"

            async def install(revision: int):
                assert (await client.post(f"/api/v2/connector-stores/{store_id}/refresh",
                                          headers=write)).status_code == 200
                return await client.put(prefix, headers=write,
                    json={"action": "install", "expected_commit": shas[revision]})

            async def installations():
                connection = await test_connect()
                try:
                    return await connection.fetchval("SELECT count(*) FROM v2_connector_installations")
                finally:
                    await connection.close()

            refused = await install(0)
            assert refused.status_code == 422
            assert refused.json()["detail"] == "Magasin ambigu : fusionnez les doublons."
            assert await installations() == 0

            failed = await install(1)
            assert failed.status_code == 503
            assert "secret internal detail" not in failed.text
            assert "initialisation du connecteur a échoué" in failed.json()["detail"]
            assert await installations() == 0

            paused = await install(2)
            assert paused.status_code == 422 and paused.json()["detail"] == "Boutique supprimée."
            assert await installations() == 0  # the installation row was rolled back with the failed resume

            ok = await install(3)
            assert ok.status_code == 200, ok.text
            assert await installations() == 1
            connection = await test_connect()
            try:
                # A fresh installation resumes the connector, so a pause kept from an earlier
                # installation does not survive it.
                assert await connection.fetchval(
                    "SELECT resume_calls FROM v2_connectors.v2_hooks_state") == 1
            finally:
                await connection.close()
    finally:
        root = await connect_v2(base)
        try:
            await root.execute('DROP DATABASE "' + db_name + '" WITH (FORCE)')
        finally:
            await root.close()


class _Hooked:
    def __init__(self, *, error=None):
        self.error, self.calls = error, 0

    async def __call__(self, _connection):
        self.calls += 1
        if self.error:
            raise self.error


@pytest.mark.asyncio
async def test_run_connector_hook_maps_each_kind_of_failure():
    from fastapi import HTTPException

    from app.api.v2.connector_stores import _run_connector_hook

    ok = _Hooked()
    await _run_connector_hook(ok, None, invalid="invalid", failed="failed")
    assert ok.calls == 1

    with pytest.raises(HTTPException) as not_callable:
        await _run_connector_hook("not a function", None, invalid="invalid", failed="failed")
    assert (not_callable.value.status_code, not_callable.value.detail) == (422, "invalid")

    with pytest.raises(HTTPException) as explained:
        await _run_connector_hook(_Hooked(error=ValueError("Message for the admin")), None,
                                  invalid="invalid", failed="failed")
    assert (explained.value.status_code, explained.value.detail) == (422, "Message for the admin")

    with pytest.raises(HTTPException) as silent:  # an empty message falls back to the generic one
        await _run_connector_hook(_Hooked(error=ValueError("")), None, invalid="invalid", failed="failed")
    assert (silent.value.status_code, silent.value.detail) == (422, "failed")

    with pytest.raises(HTTPException) as long_message:  # a connector cannot flood the admin UI
        await _run_connector_hook(_Hooked(error=ValueError("x" * 1000)), None, invalid="i", failed="f")
    assert len(long_message.value.detail) == 300

    with pytest.raises(HTTPException) as unexpected:
        await _run_connector_hook(_Hooked(error=RuntimeError("internal detail")), None,
                                  invalid="invalid", failed="failed")
    assert (unexpected.value.status_code, unexpected.value.detail) == (503, "failed")

    already = HTTPException(status_code=409, detail="Réglages modifiés.")
    with pytest.raises(HTTPException) as passthrough:  # an HTTPException from the connector is kept
        await _run_connector_hook(_Hooked(error=already), None, invalid="invalid", failed="failed")
    assert passthrough.value is already


def test_settings_accept_short_strings_for_secret_fields_and_nothing_larger():
    from pydantic import ValidationError

    from app.api.v2.connector_stores import MAX_SECRET_LENGTH, ConnectorSettingsChange, _without_secrets

    ok = ConnectorSettingsChange(expected_revision=1, values={"enabled": True, "days": 7, "api_key": "pmx_x"})
    assert ok.values == {"enabled": True, "days": 7, "api_key": "pmx_x"}
    assert ConnectorSettingsChange(expected_revision=1, values={"api_key": ""}).values == {"api_key": ""}
    for bad in ({"api_key": "x" * (MAX_SECRET_LENGTH + 1)}, {"k" * 65: 1}, {f"k{n}": n for n in range(33)},
                {"a": [1]}, {"a": None}, {"a": {"b": 1}}):
        with pytest.raises(ValidationError):
            ConnectorSettingsChange(expected_revision=1, values=bad)
    # Whatever a connector returns, the value of a secret field never goes to the browser.
    leaky = {"revision": 1, "fields": [{"key": "api_key", "type": "secret", "label": "Key"}, {"key": "n", "type": "integer"}],
             "values": {"api_key": "pmx_secret", "n": 3}}
    assert _without_secrets(leaky)["values"] == {"n": 3}
    assert "pmx_secret" not in json.dumps(_without_secrets(leaky))
    assert _without_secrets("odd") == "odd"
