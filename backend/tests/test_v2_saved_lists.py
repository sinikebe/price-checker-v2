"""Saved shopping lists: kept per account, saved once however often a retry sends them, bounded."""

from __future__ import annotations

import json
import os
import secrets
import uuid
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException

from app.api.v2 import account_data, saved_lists
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)
PATH = "/api/v2/lists"
CONTENT = {
    "source": "shared", "source_name": "Courses", "store_mode": False, "fetched_at": "2026-11-03T08:00:00+00:00",
    "sections": [
        {"retailer": None, "store": "", "cents": 0, "lines": [
            {"key": "group:riz", "label": "Riz", "missing": True, "line": {"kind": "group", "name": "Riz"}}]},
        {"retailer": "Leclerc", "store": "Houilles · Drive", "cents": 335, "lines": [
            {"key": "product:1", "label": "Lactel Lait", "detail": "1 L", "cents": 95,
             "line": {"kind": "product", "product_id": 1}, "quantity": {"amount": "2", "unit": "l"}},
            {"key": "product:3", "label": "Président Beurre", "detail": "250 g", "cents": 240}]},
    ],
}


@pytest.fixture
async def setup(monkeypatch):
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    root = await connect_v2(base)
    database = "v2_saved_lists_" + secrets.token_hex(5)
    await root.execute('CREATE DATABASE "' + database + '"')
    await root.close()
    config = {**base, "database": database}
    await migrate_v2(config)
    connection = await connect_v2(config)
    users = {}
    for name in ("alice", "bob"):
        user_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) VALUES($1,$1,'x','confirmed') RETURNING id", name)
        users[name] = {"id": user_id, "role": "confirmed", "username": name}

    async def fake_connect():
        return await connect_v2(config)

    async def fake_user(_connection, request):
        user = users.get(request.headers.get("x-test-user"))
        if user is None:
            raise HTTPException(status_code=401, detail="Connectez-vous.")
        return user

    for module in (saved_lists, account_data):
        monkeypatch.setattr(module, "_connect", fake_connect)
    monkeypatch.setattr(saved_lists, "_session_user", fake_user)
    monkeypatch.setattr(account_data, "_current_user", fake_user)
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test")
    try:
        yield client, connection, users
    finally:
        await client.aclose()
        await connection.close()
        root = await connect_v2(base)
        try:
            await root.execute('DROP DATABASE "' + database + '" WITH (FORCE)')
        finally:
            await root.close()


def who(name):
    return {"x-test-user": name}


@pytest.mark.asyncio
async def test_a_list_is_saved_once_and_seen_by_its_account_only(setup):
    client, connection, _users = setup
    list_id = str(uuid.uuid4())
    body = {"name": "  Courses du samedi ", "content": CONTENT, "checked": ["product:1"]}
    assert (await client.put(f"{PATH}/{list_id}", json=body)).status_code == 401
    saved = await client.put(f"{PATH}/{list_id}", json=body, headers=who("alice"))
    assert saved.status_code == 200, saved.text
    data = saved.json()
    assert data["id"] == list_id and data["name"] == "Courses du samedi" and data["checked"] == ["product:1"]
    assert data["content"]["sections"][1]["lines"][0]["quantity"] == {"amount": "2", "unit": "l"}
    assert saved.headers["cache-control"] == "private, no-store"
    # A retry after a lost answer changes nothing more: still one list.
    again = await client.put(f"{PATH}/{list_id}", json=body, headers=who("alice"))
    assert again.json()["revision"] == 2
    assert await connection.fetchval("SELECT count(*) FROM v2_saved_lists") == 1
    mine = (await client.get(PATH, headers=who("alice"))).json()
    assert [item["id"] for item in mine["lists"]] == [list_id] and mine["limits"] == {"lists": 30, "lines": 300}
    assert (await client.get(PATH, headers=who("bob"))).json()["lists"] == []
    # Another account cannot change or delete it, even knowing its id.
    assert (await client.patch(f"{PATH}/{list_id}", json={"name": "x"}, headers=who("bob"))).status_code == 404
    assert (await client.delete(f"{PATH}/{list_id}", headers=who("bob"))).status_code == 204
    assert await connection.fetchval("SELECT count(*) FROM v2_saved_lists") == 1
    ticked = await client.patch(f"{PATH}/{list_id}", json={"checked": ["product:1", "group:riz"]}, headers=who("alice"))
    assert ticked.json()["checked"] == ["product:1", "group:riz"] and ticked.json()["name"] == "Courses du samedi"
    renamed = await client.patch(f"{PATH}/{list_id}", json={"name": "Samedi"}, headers=who("alice"))
    assert renamed.json()["name"] == "Samedi" and renamed.json()["checked"] == ["product:1", "group:riz"]
    assert (await client.delete(f"{PATH}/{list_id}", headers=who("alice"))).status_code == 204
    assert (await client.delete(f"{PATH}/{list_id}", headers=who("alice"))).status_code == 204, "a retry succeeds too"
    assert (await client.get(PATH, headers=who("alice"))).json()["lists"] == []


@pytest.mark.asyncio
async def test_lists_are_bounded(setup, monkeypatch):
    client, _connection, _users = setup
    monkeypatch.setattr(saved_lists, "MAX_LISTS", 2)
    for _ in range(2):
        assert (await client.put(f"{PATH}/{uuid.uuid4()}", json={"name": "L", "content": CONTENT},
                                 headers=who("alice"))).status_code == 200
    full = await client.put(f"{PATH}/{uuid.uuid4()}", json={"name": "L", "content": CONTENT}, headers=who("alice"))
    assert full.status_code == 409 and "2 listes" in full.json()["detail"]
    line = CONTENT["sections"][1]["lines"][1]
    too_long = {**CONTENT, "sections": [{"retailer": "X", "lines": [line] * 301}]}
    for bad in ({"name": "", "content": CONTENT}, {"name": "L", "content": {**CONTENT, "source": "other"}},
                {"name": "L", "content": too_long}, {"name": "L", "content": CONTENT, "checked": ["x" * 401]}):
        assert (await client.put(f"{PATH}/{uuid.uuid4()}", json=bad, headers=who("bob"))).status_code == 422
    assert (await client.put(f"{PATH}/not-a-uuid", json={"name": "L", "content": CONTENT}, headers=who("bob"))).status_code == 422
    monkeypatch.setattr(saved_lists, "WRITES_PER_MINUTE", 1)
    list_id = uuid.uuid4()
    assert (await client.put(f"{PATH}/{list_id}", json={"name": "L", "content": CONTENT}, headers=who("bob"))).status_code == 200
    assert (await client.patch(f"{PATH}/{list_id}", json={"name": "M"}, headers=who("bob"))).status_code == 429


@pytest.mark.asyncio
async def test_lists_are_exported_and_go_with_the_account(setup):
    client, connection, users = setup
    list_id = str(uuid.uuid4())
    await client.put(f"{PATH}/{list_id}", json={"name": "Samedi", "content": CONTENT, "checked": ["product:3"]}, headers=who("alice"))
    exported = (await client.get("/api/v2/account/export", headers=who("alice"))).json()
    assert [(str(item["list_id"]), item["name"], item["checked"]) for item in exported["saved_lists"]] == [(list_id, "Samedi", ["product:3"])]
    assert exported["saved_lists"][0]["content"]["source_name"] == "Courses"
    await connection.execute("DELETE FROM v2_users WHERE id=$1", users["alice"]["id"])
    assert await connection.fetchval("SELECT count(*) FROM v2_saved_lists") == 0
