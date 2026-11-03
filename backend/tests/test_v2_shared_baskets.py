"""Shared baskets: stored on purpose, joined by invitation, edited live by their members."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException

from app.api.v2 import account_data, shared_baskets
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)
PATH = "/api/v2/shared-baskets"


@pytest.fixture
async def setup(monkeypatch):
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    root = await connect_v2(base)
    database = "v2_shared_baskets_" + secrets.token_hex(5)
    await root.execute('CREATE DATABASE "' + database + '"')
    await root.close()
    config = {**base, "database": database}
    await migrate_v2(config)
    connection = await connect_v2(config)
    users = {}
    for name in ("alice", "bob", "carol", "dave"):
        user_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES($1,$1,'test','confirmed') RETURNING id", name)
        users[name] = {"id": user_id, "role": "confirmed", "username": name}
    products = {}
    for name in ("Lait", "Pâtes", "Retiré"):
        products[name] = await connection.fetchval(
            "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
            json.dumps({"brand": "Marque", "name": name, "group": name}))
    moderator = await connection.fetchval(
        "INSERT INTO v2_users(username,username_key,password_hash,role) "
        "VALUES('moderator','moderator','test','admin') RETURNING id")
    await connection.execute(
        "INSERT INTO v2_content_withdrawals(kind,content_id,reason,withdrawn_by) "
        "VALUES('product',$1,'test',$2)", products["Retiré"], moderator)

    async def fake_connect():
        return await connect_v2(config)

    async def fake_session_user(_connection, request):
        user = users.get(request.headers.get("x-test-user"))
        if user is None:
            raise HTTPException(status_code=401, detail="Connectez-vous.")
        return user

    monkeypatch.setattr(shared_baskets, "_connect", fake_connect)
    monkeypatch.setattr(shared_baskets, "_session_user", fake_session_user)
    monkeypatch.setattr(shared_baskets, "_live", shared_baskets._Live())
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test")
    try:
        yield client, connection, users, products
    finally:
        await client.aclose()
        await connection.close()
        root = await connect_v2(base)
        try:
            await root.execute('DROP DATABASE "' + database + '" WITH (FORCE)')
        finally:
            await root.close()


def who(name: str) -> dict:
    return {"x-test-user": name}


def product(product_id: int, **extra) -> dict:
    return {"line": {"kind": "product", "product_id": product_id}, **extra}


async def create(client, products, name="alice"):
    response = await client.post(PATH, headers=who(name), json={
        "name": "Courses de la semaine",
        "lines": [product(products["Lait"], quantity={"amount": "2", "unit": "l"}),
                  {"line": {"kind": "group", "name": "Pâtes"}, "disabled": True}],
    })
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.asyncio
async def test_a_shared_basket_is_created_from_the_basket_and_seen_by_members_only(setup):
    client, _connection, users, products = setup
    assert (await client.post(PATH, json={"name": "x"})).status_code == 401
    state = await create(client, products)
    assert state["role"] == "owner" and state["owner"] == "alice"
    assert [member["username"] for member in state["members"]] == ["alice"]
    lait, pates = state["lines"]
    assert lait["kind"] == "product" and lait["label"] == "Marque Lait"
    assert lait["product"]["id"] == products["Lait"] and lait["product"]["data"]["name"] == "Lait"
    assert lait["quantity"] == {"amount": "2", "unit": "l"} and lait["added_by"] == "alice" and lait["mine"]
    assert pates["kind"] == "group" and pates["label"] == "Pâtes" and pates["disabled"] is True
    basket_id = state["id"]
    assert (await client.get(f"{PATH}/{basket_id}", headers=who("bob"))).status_code == 404
    mine = (await client.get(PATH, headers=who("alice"))).json()["baskets"]
    assert [(item["id"], item["owner"], item["lines"], item["members"]) for item in mine] == [
        (basket_id, True, 2, 1)]
    read = await client.get(f"{PATH}/{basket_id}", headers=who("alice"))
    assert read.headers["cache-control"] == "private, no-store"
    assert read.json()["invite"] == state["invite"]


@pytest.mark.asyncio
async def test_members_join_by_invitation_and_a_new_link_cancels_the_old_one(setup):
    client, _connection, _users, products = setup
    state = await create(client, products)
    basket_id, invite = state["id"], state["invite"]
    wrong = invite[:-1] + ("A" if invite[-1] != "A" else "B")
    assert (await client.post(f"{PATH}/join", headers=who("bob"), json={"invite": wrong})).status_code == 404
    assert (await client.post(f"{PATH}/join", headers=who("bob"), json={"invite": "nonsense"})).status_code == 404
    preview = await client.post(f"{PATH}/join", headers=who("bob"), json={"invite": invite})
    assert preview.json() == {"id": basket_id, "name": "Courses de la semaine", "owner": "alice",
                              "lines": 2, "members": 1, "member": False}
    # A preview joins nothing.
    assert (await client.get(f"{PATH}/{basket_id}", headers=who("bob"))).status_code == 404
    joined = await client.post(f"{PATH}/join", headers=who("bob"), json={"invite": invite, "confirm": True})
    assert joined.status_code == 200 and joined.json()["member"] is True
    seen = (await client.get(f"{PATH}/{basket_id}", headers=who("bob"))).json()
    assert seen["role"] == "member" and [m["username"] for m in seen["members"]] == ["alice", "bob"]
    assert seen["revision"] == state["revision"] + 1
    # Members cannot renew the link, rename or delete; the owner can.
    assert (await client.post(f"{PATH}/{basket_id}/invite", headers=who("bob"))).status_code == 403
    assert (await client.patch(f"{PATH}/{basket_id}", headers=who("bob"), json={"name": "x"})).status_code == 403
    assert (await client.delete(f"{PATH}/{basket_id}", headers=who("bob"))).status_code == 403
    renewed = (await client.post(f"{PATH}/{basket_id}/invite", headers=who("alice"))).json()
    assert renewed["invite"] != invite
    assert (await client.post(f"{PATH}/join", headers=who("carol"), json={"invite": invite})).status_code == 404
    assert (await client.post(f"{PATH}/join", headers=who("carol"),
                              json={"invite": renewed["invite"], "confirm": True})).status_code == 200
    # bob, already in, is still in.
    assert (await client.get(f"{PATH}/{basket_id}", headers=who("bob"))).status_code == 200


@pytest.mark.asyncio
async def test_changes_apply_by_line_and_an_article_is_added_once(setup):
    client, _connection, _users, products = setup
    state = await create(client, products)
    basket_id = state["id"]
    await client.post(f"{PATH}/join", headers=who("bob"), json={"invite": state["invite"], "confirm": True})
    changed = await client.post(f"{PATH}/{basket_id}/changes", headers=who("bob"), json={"ops": [
        {"op": "add", **product(products["Pâtes"])},
        {"op": "add", **product(products["Lait"])},  # already there: kept once, quantity unchanged
        {"op": "add", "line": {"kind": "scope", "department": "Épicerie", "family": "Pâtes", "name": "Spaghetti"}},
        {"op": "update", "line": {"kind": "group", "name": "pâtes"}, "disabled": False,
         "quantity": {"amount": "500", "unit": "g"}},
        {"op": "update", **product(products["Lait"]), "quantity": None},
        {"op": "remove", "line": {"kind": "group", "name": "Riz"}},  # not there (removed meanwhile): nothing to do
    ]})
    assert changed.status_code == 200, changed.text
    lines = changed.json()["lines"]
    assert [line["label"] for line in lines] == ["Marque Lait", "Pâtes", "Marque Pâtes", "Spaghetti"]
    assert lines[0]["quantity"] is None and lines[0]["added_by"] == "alice" and not lines[0]["mine"]
    assert lines[1]["disabled"] is False and lines[1]["quantity"] == {"amount": "500", "unit": "g"}
    assert lines[2]["added_by"] == "bob" and lines[2]["mine"]
    assert lines[3]["department"] == "Épicerie" and lines[3]["family"] == "Pâtes"
    # A withdrawn product is refused, and the whole change with it.
    spaghetti = {"kind": "scope", "department": "Épicerie", "family": "Pâtes", "name": "Spaghetti"}
    refused = await client.post(f"{PATH}/{basket_id}/changes", headers=who("alice"), json={"ops": [
        {"op": "remove", "line": spaghetti}, {"op": "add", **product(products["Retiré"])}]})
    assert refused.status_code == 422
    after = (await client.get(f"{PATH}/{basket_id}", headers=who("alice"))).json()
    assert len(after["lines"]) == 4 and after["revision"] == changed.json()["revision"]
    # Changes that change nothing do not make members read again.
    same = await client.post(f"{PATH}/{basket_id}/changes", headers=who("alice"),
                             json={"ops": [{"op": "add", **product(products["Lait"])}]})
    assert same.json()["revision"] == after["revision"]
    bad = await client.post(f"{PATH}/{basket_id}/changes", headers=who("alice"), json={"ops": [
        {"op": "update", **product(products["Lait"]), "quantity": {"amount": "0", "unit": "g"}}]})
    assert bad.status_code == 422
    assert (await client.post(f"{PATH}/{basket_id}/changes", headers=who("carol"),
                              json={"ops": [{"op": "remove", **product(products["Lait"])}]})).status_code == 404
    # Removing then adding the same article in one change: it ends up in the basket, once.
    again = await client.post(f"{PATH}/{basket_id}/changes", headers=who("alice"), json={"ops": [
        {"op": "remove", **product(products["Lait"])}, {"op": "add", **product(products["Lait"])}]})
    assert [line["label"] for line in again.json()["lines"]].count("Marque Lait") == 1


@pytest.mark.asyncio
async def test_a_waiting_read_returns_as_soon_as_another_member_changes_the_basket(setup):
    client, _connection, _users, products = setup
    state = await create(client, products)
    basket_id = state["id"]
    await client.post(f"{PATH}/join", headers=who("bob"), json={"invite": state["invite"], "confirm": True})
    revision = (await client.get(f"{PATH}/{basket_id}", headers=who("bob"))).json()["revision"]
    waiting = asyncio.create_task(client.get(f"{PATH}/{basket_id}", headers=who("bob"),
                                             params={"after": revision, "wait": "true"}))
    for _ in range(50):
        if shared_baskets._live.waiting.get(basket_id):
            break
        await asyncio.sleep(0.02)
    assert shared_baskets._live.waiting[basket_id] == 1
    started = asyncio.get_running_loop().time()
    await client.post(f"{PATH}/{basket_id}/changes", headers=who("alice"),
                      json={"ops": [{"op": "add", **product(products["Pâtes"])}]})
    answer = await asyncio.wait_for(waiting, 5)
    assert asyncio.get_running_loop().time() - started < 2
    assert answer.status_code == 200 and answer.json()["revision"] == revision + 1
    assert answer.json()["lines"][-1]["added_by"] == "alice"
    assert not shared_baskets._live.waiting and not shared_baskets._live.accounts
    # Behind already: answered at once, without waiting.
    stale = await client.get(f"{PATH}/{basket_id}", headers=who("bob"), params={"after": revision, "wait": "true"})
    assert stale.status_code == 200 and stale.json()["revision"] == revision + 1


@pytest.mark.asyncio
async def test_waiting_reads_are_bounded_and_end_with_no_change(setup, monkeypatch):
    client, _connection, _users, products = setup
    monkeypatch.setattr(shared_baskets, "WAIT_SECONDS", 1)
    monkeypatch.setattr(shared_baskets, "WAIT_SLICE", 1)
    monkeypatch.setattr(shared_baskets, "MAX_WAITERS_PER_ACCOUNT", 1)
    state = await create(client, products)
    basket_id, revision = state["id"], state["revision"]
    params = {"after": revision, "wait": "true"}
    first = asyncio.create_task(client.get(f"{PATH}/{basket_id}", headers=who("alice"), params=params))
    for _ in range(50):
        if shared_baskets._live.waiting.get(basket_id):
            break
        await asyncio.sleep(0.02)
    # No second live slot for this account: told to read again later instead of waiting.
    second = await client.get(f"{PATH}/{basket_id}", headers=who("alice"), params=params)
    assert second.status_code == 204 and second.headers["retry-after"] == "10"
    timed_out = await asyncio.wait_for(first, 5)
    assert timed_out.status_code == 204 and "retry-after" not in timed_out.headers
    assert not shared_baskets._live.waiting


@pytest.mark.asyncio
async def test_members_leave_or_are_removed_and_their_lines_stay(setup):
    client, _connection, users, products = setup
    state = await create(client, products)
    basket_id = state["id"]
    for name in ("bob", "carol"):
        await client.post(f"{PATH}/join", headers=who(name), json={"invite": state["invite"], "confirm": True})
    await client.post(f"{PATH}/{basket_id}/changes", headers=who("bob"),
                      json={"ops": [{"op": "add", **product(products["Pâtes"])}]})
    assert (await client.delete(f"{PATH}/{basket_id}/members/{users['carol']['id']}",
                                headers=who("bob"))).status_code == 403
    assert (await client.delete(f"{PATH}/{basket_id}/members/{users['alice']['id']}",
                                headers=who("alice"))).status_code == 409
    assert (await client.delete(f"{PATH}/{basket_id}/members/{users['bob']['id']}",
                                headers=who("bob"))).status_code == 204
    assert (await client.get(f"{PATH}/{basket_id}", headers=who("bob"))).status_code == 404
    assert (await client.delete(f"{PATH}/{basket_id}/members/{users['carol']['id']}",
                                headers=who("alice"))).status_code == 204
    # Removed by the owner: the old link no longer lets carol in; bob, who left by himself, could rejoin.
    assert (await client.post(f"{PATH}/join", headers=who("carol"), json={"invite": state["invite"], "confirm": True})).status_code == 404
    left = (await client.get(f"{PATH}/{basket_id}", headers=who("alice"))).json()
    assert left["invite"] != state["invite"]
    assert [m["username"] for m in left["members"]] == ["alice"]
    assert left["lines"][-1]["added_by"] == "bob"
    renamed = await client.patch(f"{PATH}/{basket_id}", headers=who("alice"), json={"name": "  Week-end  "})
    assert renamed.json()["name"] == "Week-end"
    assert (await client.delete(f"{PATH}/{basket_id}", headers=who("alice"))).status_code == 204
    assert (await client.get(f"{PATH}/{basket_id}", headers=who("alice"))).status_code == 404


@pytest.mark.asyncio
async def test_limits_on_baskets_lines_and_members(setup, monkeypatch):
    client, connection, _users, products = setup
    monkeypatch.setattr(shared_baskets, "MAX_OWNED", 1)
    monkeypatch.setattr(shared_baskets, "MAX_LINES", 3)
    monkeypatch.setattr(shared_baskets, "MAX_MEMBERS", 2)
    state = await create(client, products)
    assert (await client.post(PATH, headers=who("alice"), json={"name": "Deux"})).status_code == 409
    full = await client.post(f"{PATH}/{state['id']}/changes", headers=who("alice"), json={"ops": [
        {"op": "add", **product(products["Pâtes"])},
        {"op": "add", "line": {"kind": "group", "name": "Riz"}}]})
    assert full.status_code == 409 and "3 articles" in full.json()["detail"]
    assert await connection.fetchval("SELECT count(*) FROM v2_shared_basket_lines") == 2
    await client.post(f"{PATH}/join", headers=who("bob"), json={"invite": state["invite"], "confirm": True})
    crowded = await client.post(f"{PATH}/join", headers=who("carol"), json={"invite": state["invite"], "confirm": True})
    assert crowded.status_code == 409
    monkeypatch.setattr(shared_baskets, "READS_PER_MINUTE", 2)
    reads = [await client.get(f"{PATH}/{state['id']}", headers=who("bob")) for _ in range(3)]
    assert [read.status_code for read in reads] == [200, 200, 429]
    assert reads[2].headers["retry-after"] == "10"
    assert (await client.get(f"{PATH}/{state['id']}", headers=who("alice"))).status_code == 200
    monkeypatch.setattr(shared_baskets, "WRITES_PER_MINUTE", 1)
    ops = {"ops": [{"op": "add", "line": {"kind": "group", "name": "Riz"}}]}
    assert (await client.post(f"{PATH}/{state['id']}/changes", headers=who("dave"), json=ops)).status_code == 404
    await client.post(f"{PATH}/{state['id']}/changes", headers=who("bob"), json=ops)
    assert (await client.post(f"{PATH}/{state['id']}/changes", headers=who("bob"), json=ops)).status_code == 429


@pytest.mark.asyncio
async def test_account_export_and_deletion(setup, monkeypatch):
    client, connection, users, products = setup
    state = await create(client, products)
    basket_id = state["id"]
    await client.post(f"{PATH}/join", headers=who("bob"), json={"invite": state["invite"], "confirm": True})
    await client.post(f"{PATH}/{basket_id}/changes", headers=who("bob"),
                      json={"ops": [{"op": "add", **product(products["Pâtes"])}]})
    bob_basket = (await client.post(PATH, headers=who("bob"), json={"name": "À moi"})).json()["id"]

    async def fake_connect():
        return await shared_baskets._connect()

    async def fake_session_user(_connection, request):
        return users[request.headers["x-test-user"]]

    monkeypatch.setattr(account_data, "_connect", fake_connect)
    monkeypatch.setattr(account_data, "_current_user", fake_session_user, raising=False)
    monkeypatch.setattr(account_data, "_session_user", fake_session_user, raising=False)
    exported = await client.get("/api/v2/account/export", headers=who("bob"))
    assert exported.status_code == 200, exported.text
    data = exported.json()
    assert [(item["id"], item["owner"]) for item in data["shared_baskets"]] == [(basket_id, False), (bob_basket, True)]
    lines = data["shared_basket_lines"]
    assert [(line["label"], line["added_by_me"]) for line in lines] == [
        ("Marque Lait", False), ("Pâtes", False), ("Marque Pâtes", True)]
    assert lines[0]["quantity"] == {"amount": "2", "unit": "l"}
    assert "alice" not in json.dumps(lines)
    # Deleting an account deletes its own shared baskets; its lines elsewhere stay, unattributed.
    await connection.execute("DELETE FROM v2_users WHERE id=$1", users["bob"]["id"])
    assert await connection.fetchval("SELECT count(*) FROM v2_shared_baskets WHERE id=$1", bob_basket) == 0
    remaining = (await client.get(f"{PATH}/{basket_id}", headers=who("alice"))).json()
    assert [m["username"] for m in remaining["members"]] == ["alice"]
    assert remaining["lines"][-1]["label"] == "Marque Pâtes" and remaining["lines"][-1]["added_by"] is None
    await connection.execute("DELETE FROM v2_users WHERE id=$1", users["alice"]["id"])
    assert await connection.fetchval("SELECT count(*) FROM v2_shared_basket_lines") == 0


@pytest.mark.asyncio
async def test_settings_are_shared_by_every_member(setup):
    client, _connection, _users, products = setup
    created = await client.post(PATH, headers=who("alice"), json={
        "name": "Réglages", "lines": [product(products["Lait"])],
        "settings": {"advanced": True, "filters": {"storeIds": [4], "cities": [], "departments": ["78"]}},
    })
    state = created.json()
    assert state["settings"] == {"advanced": True, "compare": "price",
                                 "filters": {"storeIds": [4], "cities": [], "departments": ["78"]},
                                 "stores_off": [], "units": {}, "checked": [], "list_mode": "all"}
    basket_id = state["id"]
    await client.post(f"{PATH}/join", headers=who("bob"), json={"invite": state["invite"], "confirm": True})
    changed = await client.post(f"{PATH}/{basket_id}/changes", headers=who("bob"), json={"ops": [
        {"op": "settings", "compare": "unit", "stores_off": ["12:drive", "3:in_store"]},
        {"op": "settings", "units": {f"product:{products['Lait']}": "piece"}},
        {"op": "settings", "checked": [f"product:{products['Lait']}"]},
        {"op": "settings", "list_mode": "store:12:drive"},
    ]})
    assert changed.status_code == 200, changed.text
    seen = (await client.get(f"{PATH}/{basket_id}", headers=who("alice"))).json()
    assert seen["settings"] == {"advanced": True, "compare": "unit",
                                "filters": {"storeIds": [4], "cities": [], "departments": ["78"]},
                                "stores_off": ["12:drive", "3:in_store"],
                                "units": {f"product:{products['Lait']}": "piece"},
                                "checked": [f"product:{products['Lait']}"], "list_mode": "store:12:drive"}
    assert seen["revision"] == changed.json()["revision"] == state["revision"] + 2
    # The same settings again change nothing, so nobody reads again.
    same = await client.post(f"{PATH}/{basket_id}/changes", headers=who("alice"),
                             json={"ops": [{"op": "settings", "compare": "unit"}]})
    assert same.json()["revision"] == seen["revision"]
    for bad in ({"compare": "cheapest"}, {"stores_off": ["12:bike"]}, {"units": {"x": "kg"}},
                {"filters": {"storeIds": [0]}}, {"filters": {"departments": ["Paris"]}},
                {"stores_off": [f"{n + 1}:drive" for n in range(51)]}, {"checked": ["x" * 401]},
                {"list_mode": "store:12"}, {"list_mode": "cheapest"}):
        refused = await client.post(f"{PATH}/{basket_id}/changes", headers=who("alice"),
                                    json={"ops": [{"op": "settings", **bad}]})
        assert refused.status_code == 422, bad


@pytest.mark.asyncio
async def test_ticks_from_several_members_add_up(setup, monkeypatch):
    client, _connection, _users, products = setup
    state = await create(client, products)
    basket_id = state["id"]
    await client.post(f"{PATH}/join", headers=who("bob"), json={"invite": state["invite"], "confirm": True})
    lait, pates = f"product:{products['Lait']}", "group:pâtes"
    # Alice ticks the milk; Bob, back online later, sends the ticks he made meanwhile.
    first = await client.post(f"{PATH}/{basket_id}/changes", headers=who("alice"), json={"ops": [{"op": "tick", "key": lait, "on": True}]})
    assert first.status_code == 200 and first.json()["settings"]["checked"] == [lait]
    late = await client.post(f"{PATH}/{basket_id}/changes", headers=who("bob"),
                             json={"ops": [{"op": "tick", "key": pates, "on": True}, {"op": "tick", "key": lait, "on": True}]})
    assert late.json()["settings"]["checked"] == [lait, pates], "nobody's ticks are lost"
    assert late.json()["revision"] == first.json()["revision"] + 1, "an article ticked twice changes nothing more"
    off = await client.post(f"{PATH}/{basket_id}/changes", headers=who("alice"), json={"ops": [{"op": "tick", "key": lait, "on": False}]})
    assert off.json()["settings"]["checked"] == [pates]
    again = await client.post(f"{PATH}/{basket_id}/changes", headers=who("alice"), json={"ops": [{"op": "tick", "key": lait, "on": False}]})
    assert again.json()["revision"] == off.json()["revision"], "unticking an article not ticked changes nothing"
    monkeypatch.setattr(shared_baskets, "MAX_LINES", 1)
    full = await client.post(f"{PATH}/{basket_id}/changes", headers=who("bob"), json={"ops": [{"op": "tick", "key": lait, "on": True}]})
    assert full.json()["settings"]["checked"] == [pates], "the ticks stay bounded"
    for bad in ({"key": "", "on": True}, {"key": "x" * 401, "on": True}, {"key": lait}):
        assert (await client.post(f"{PATH}/{basket_id}/changes", headers=who("bob"), json={"ops": [{"op": "tick", **bad}]})).status_code == 422, bad


@pytest.mark.asyncio
async def test_refused_changes_still_count_toward_the_write_limit(setup, monkeypatch):
    client, _connection, _users, products = setup
    state = await create(client, products)
    monkeypatch.setattr(shared_baskets, "WRITES_PER_MINUTE", 3)  # creating the basket was the first
    refused = {"ops": [{"op": "add", **product(products["Retiré"])}]}  # withdrawn product: 422, rolled back
    for _ in range(2):
        assert (await client.post(f"{PATH}/{state['id']}/changes", headers=who("alice"), json=refused)).status_code == 422
    third = await client.post(f"{PATH}/{state['id']}/changes", headers=who("alice"),
                              json={"ops": [{"op": "add", "line": {"kind": "group", "name": "Riz"}}]})
    assert third.status_code == 429


@pytest.mark.asyncio
async def test_the_attempt_is_counted_before_the_write_transaction(setup):
    _client, connection, users, _products = setup
    async with connection.transaction():
        with pytest.raises(RuntimeError):
            await shared_baskets._write_limit(connection, users["alice"])


@pytest.mark.asyncio
async def test_free_text_lines_wait_in_the_basket_until_replaced(setup):
    client, _connection, _users, products = setup
    state = await create(client, products)
    basket_id = state["id"]
    added = await client.post(f"{PATH}/{basket_id}/changes", headers=who("alice"), json={"ops": [
        {"op": "add", "line": {"kind": "text", "name": "  Sauce  tomate maison "}, "quantity": {"amount": "2", "unit": "package"}},
        {"op": "add", "line": {"kind": "text", "name": "sauce tomate maison"}},
    ]})
    assert added.status_code == 200, added.text
    text = [line for line in added.json()["lines"] if line["kind"] == "text"]
    assert [(line["label"], line["product"], line["quantity"]) for line in text] == [("Sauce tomate maison", None, {"amount": "2", "unit": "package"})], \
        "free text is one line, whatever its case and spaces"
    replaced = await client.post(f"{PATH}/{basket_id}/changes", headers=who("alice"), json={"ops": [
        {"op": "remove", "line": {"kind": "text", "name": "Sauce tomate maison"}},
        {"op": "add", "line": {"kind": "group", "name": "Sauce tomate"}, "quantity": {"amount": "2", "unit": "package"}},
    ]})
    assert [line["kind"] for line in replaced.json()["lines"]] == ["product", "group", "group"]
    for bad in ({"kind": "text", "name": ""}, {"kind": "text", "name": "x" * 101}):
        refused = await client.post(f"{PATH}/{basket_id}/changes", headers=who("alice"), json={"ops": [{"op": "add", "line": bad}]})
        assert refused.status_code == 422, bad


async def priced(connection, products):
    retailer = await connection.fetchval("INSERT INTO v2_retailers(code,name) VALUES('sb','Enseigne') RETURNING id")
    store = await connection.fetchval(
        "INSERT INTO v2_stores(retailer_id,name,city,postal_code) VALUES($1,'Centre','Lyon','69003') RETURNING id", retailer)
    for name in ("Lait", "Pâtes"):
        await connection.execute(
            "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,source,price,observed_at) "
            "VALUES($1,$2,$3,'manual',1.5,now())", products[name], retailer, store)
    return store


@pytest.mark.asyncio
async def test_one_member_pays_for_the_prices_and_every_member_sees_them(setup):
    client, connection, users, products = setup
    await priced(connection, products)
    state = await create(client, products)
    basket_id = state["id"]
    await client.post(f"{PATH}/join", headers=who("bob"), json={"invite": state["invite"], "confirm": True})
    await client.post(f"{PATH}/{basket_id}/changes", headers=who("alice"), json={"ops": [
        {"op": "add", "line": {"kind": "text", "name": "Bougies"}}]})
    assert (await client.get(f"{PATH}/{basket_id}/prices", headers=who("bob"))).json() == {"prices": None}
    assert state["prices"] is None
    assert (await client.post(f"{PATH}/{basket_id}/prices", headers=who("carol"))).status_code == 404, "members only"

    fetched = await client.post(f"{PATH}/{basket_id}/prices", headers=who("alice"))
    assert fetched.status_code == 200, fetched.text
    body = fetched.json()
    assert body["cost"] == 1, "one credit per included article: the excluded group and the free text cost nothing"
    content = body["prices"]["content"]
    milk = next(line for line in state["lines"] if line["kind"] == "product")
    assert content["line_ids"] == [milk["id"]] and content["lines"][0]["product_ids"] == [products["Lait"]]
    assert content["prices"][str(products["Lait"])]["latest_by_store"][0]["price"] == "1.50"
    assert body["prices"]["fetched_by"] == "alice"
    spent = await connection.fetchval("SELECT balance FROM v2_basket_credits WHERE user_id=$1", users["alice"]["id"])

    seen = await client.get(f"{PATH}/{basket_id}", headers=who("bob"))
    assert seen.json()["prices"]["fetched_by"] == "alice" and seen.json()["revision"] > state["revision"], "members are told, live"
    shared = await client.get(f"{PATH}/{basket_id}/prices", headers=who("bob"))
    assert shared.json()["prices"]["content"] == content
    assert await connection.fetchval("SELECT count(*) FROM v2_basket_credits WHERE user_id=$1", users["bob"]["id"]) == 0, \
        "Bob sees the prices without spending a credit"
    assert await connection.fetchval("SELECT balance FROM v2_basket_credits WHERE user_id=$1", users["alice"]["id"]) == spent

    logged = await connection.fetch("SELECT data FROM v2_logs WHERE event='basket.prices.fetched' ORDER BY id")
    assert json.loads(logged[-1]["data"])["shared"] is True and "alice" not in logged[-1]["data"]

    only_text = await client.post(PATH, headers=who("bob"), json={"name": "Texte", "lines": [{"line": {"kind": "text", "name": "Bougies"}}]})
    refused = await client.post(f"{PATH}/{only_text.json()['id']}/prices", headers=who("bob"))
    assert refused.status_code == 422, "nothing to price, nothing spent"


@pytest.mark.asyncio
async def test_anyone_with_the_link_sees_the_basket_and_its_prices_without_names(setup, monkeypatch):
    client, connection, _users, products = setup
    await priced(connection, products)
    state = await create(client, products)
    basket_id = state["id"]
    await client.post(f"{PATH}/{basket_id}/prices", headers=who("alice"))
    view = await client.post(f"{PATH}/view", json={"invite": state["invite"]})
    assert view.status_code == 200, view.text
    body = view.json()
    assert body["name"] == "Courses de la semaine" and len(body["lines"]) == 2
    assert all("added_by" not in line and "mine" not in line for line in body["lines"]), "no member's name for a visitor"
    assert "fetched_by" not in body["prices"] and body["prices"]["content"]["line_ids"]
    assert "alice" not in view.text and "invite" not in body
    assert view.headers["cache-control"] == "private, no-store"
    wrong = state["invite"][:-1] + ("A" if state["invite"][-1] != "A" else "B")
    assert (await client.post(f"{PATH}/view", json={"invite": wrong})).status_code == 404
    assert (await client.post(f"{PATH}/view", json={"invite": "nonsense"})).status_code == 404
    renewed = await client.post(f"{PATH}/{basket_id}/invite", headers=who("alice"))
    assert (await client.post(f"{PATH}/view", json={"invite": state["invite"]})).status_code == 404, "a renewed link closes the old one"
    assert (await client.post(f"{PATH}/view", json={"invite": renewed.json()["invite"]})).status_code == 200
    monkeypatch.setattr(shared_baskets, "VIEWS_PER_MINUTE", 1)
    statuses = [(await client.post(f"{PATH}/view", json={"invite": renewed.json()["invite"]})).status_code for _ in range(2)]
    assert statuses[-1] == 429, "views by link are limited per client"
