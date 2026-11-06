"""Selections: one basket line combining products, groups, ensembles, families or departments."""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi import HTTPException

from app.api.v2 import basket, catalogue, demo_basket, shared_baskets
from app.db.v2_migrations import connect_v2
from app.main_v2 import app
from conftest import disposable_database, requires_v2_db

pytestmark = requires_v2_db
SHARED = "/api/v2/shared-baskets"
PREVIEW = "/api/v2/basket/selection"

# group -> (department, family, scope or None), and its products: (brand, name, tags)
CATALOGUE = {
    "Jus d'orange bio": (("Boissons", "Jus de fruits", "Jus d'orange"), [
        ("Soleil", "Pur jus d'orange bio", ["bio"]), ("Verger", "Jus d'orange bio", ["bio"])]),
    "Jus d'orange à base de concentré": (("Boissons", "Jus de fruits", "Jus d'orange"), [
        ("Soleil", "Jus d'orange", [])]),
    "Nectar de pomme": (("Boissons", "Jus de fruits", None), [
        ("Verger", "Nectar de pomme", []), ("Verger", "Nectar de pomme bio", ["bio"])]),
    "Eaux plates": (("Boissons", "Eaux", None), [("Source", "Eau plate", [])]),
    "Chips": (("Épicerie salée", "Apéritif", None), [("Croustille", "Chips nature", [])]),
}


@pytest.fixture
async def setup(monkeypatch):
    async with disposable_database("v2_selections_") as config:
        connection = await connect_v2(config)
        ids: dict[str, int] = {}
        for group, ((department, family, scope), products) in CATALOGUE.items():
            await connection.execute(
                "INSERT INTO v2_catalogue_classifications(group_key,group_name,department,family,comparison_scope,source) "
                "VALUES(lower($1),$1,$2,$3,$4,'manual')", group, department, family, scope)
            for brand, name, tags in products:
                ids[name] = await connection.fetchval(
                    "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
                    json.dumps({"brand": brand, "name": name, "group": group, "tags": tags, "quantity": "1 L"}))
        # A product left unclassified, and a product replaced by a new version.
        ids["Biscuit"] = await connection.fetchval(
            "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
            json.dumps({"brand": "Four", "name": "Biscuit", "group": "Biscuits"}))
        ids["Successor"] = await connection.fetchval(
            "INSERT INTO v2_products(data,predecessor_id) VALUES($1::jsonb,$2) RETURNING id",
            json.dumps({"brand": "Source", "name": "Eau plate 2", "group": "Eaux plates"}), ids["Eau plate"])
        user = {"id": await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) VALUES('ana','ana','test','confirmed') RETURNING id"),
            "role": "confirmed", "username": "ana"}

        async def fake_connect():
            return await connect_v2(config)

        async def fake_session_user(_connection, request):
            if request.headers.get("x-test-user") != "ana":
                raise HTTPException(status_code=401, detail="Connectez-vous.")
            return user

        for module in (basket, catalogue, shared_baskets, demo_basket):
            monkeypatch.setattr(module, "_connect", fake_connect)
        for module in (basket, shared_baskets):
            monkeypatch.setattr(module, "_session_user", fake_session_user)
        monkeypatch.setattr(shared_baskets, "_live", shared_baskets._Live())
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test")
        try:
            yield client, connection, ids
        finally:
            await client.aclose()
            await connection.close()


ANA = {"x-test-user": "ana"}


def names(result) -> set[str]:
    return {item["name"] for item in result["sample"]}


@pytest.mark.asyncio
async def test_a_selection_combines_levels_and_keeps_products_with_every_word(setup):
    client, _connection, _ids = setup
    # Any organic fruit juice: the family, kept to products saying "bio" (in a name or a tag).
    organic = (await client.post(PREVIEW, json={
        "name": "Jus de fruits bio", "include": [{"family": "Jus de fruits"}], "words": ["BIO"]})).json()
    assert names(organic) == {"Pur jus d'orange bio", "Jus d'orange bio", "Nectar de pomme bio"}
    assert organic["products"] == 3 and organic["truncated"] is False
    assert organic["include"] == [{"index": 0, "level": "family", "products": 5}]
    assert {group["name"] for group in organic["groups"]} == {"Jus d'orange bio", "Nectar de pomme"}
    # Any fruit juice except nectars, written without accents or capitals, plus one product and a department.
    mixed = (await client.post(PREVIEW, json={
        "name": "Boissons", "include": [{"scope": "jus d'orange", "family": "JUS DE FRUITS"}, {"department": "epicerie salee"},
                                        {"group": "Nectar de pomme"}],
        "exclude": [{"group": "nectar de pomme"}]})).json()
    assert names(mixed) == {"Pur jus d'orange bio", "Jus d'orange bio", "Jus d'orange", "Chips nature"}
    assert [member["products"] for member in mixed["include"]] == [3, 1, 2]
    # Straight and curly apostrophes are the same.
    curly = (await client.post(PREVIEW, json={"name": "x", "include": [{"group": "Jus d’orange bio"}]})).json()
    assert curly["include"][0]["products"] == 2
    # A misspelt part matches nothing, and says so.
    typo = (await client.post(PREVIEW, json={"name": "x", "include": [{"family": "Jus de fruit"}, {"group": "Chips"}]})).json()
    assert [member["products"] for member in typo["include"]] == [0, 1]
    # Unclassified groups sit under "À classer", as the catalogue shows them.
    unclassified = (await client.post(PREVIEW, json={"name": "x", "include": [{"department": "A classer"}]})).json()
    assert names(unclassified) == {"Biscuit"}


@pytest.mark.asyncio
async def test_products_follow_their_new_version_and_bad_shapes_are_refused(setup):
    client, _connection, ids = setup
    replaced = (await client.post(PREVIEW, json={"name": "Eau", "include": [{"product": ids["Eau plate"]}]})).json()
    assert [item["id"] for item in replaced["sample"]] == [ids["Successor"]]
    # A product member, old version or current, counts the current product; an unknown one counts nothing.
    members = (await client.post(PREVIEW, json={"name": "Eau", "include": [
        {"product": ids["Eau plate"]}, {"product": ids["Successor"]}, {"product": 999999}, {"group": "Eaux plates"},
        {"scope": "Jus d'orange"}, {"family": "Jus de fruits", "department": "Boissons"}, {"department": "Boissons"}],
        "exclude": [{"product": ids["Eau plate"]}]})).json()
    assert [(member["level"], member["products"]) for member in members["include"]] == [
        ("product", 1), ("product", 1), ("product", 0), ("group", 1), ("scope", 3), ("family", 5), ("department", 6)]
    assert ids["Successor"] not in {item["id"] for item in members["sample"]}, "excluding the old version excludes the current one"
    for wrong in (
        {"name": "x", "include": []},
        {"name": "x", "include": [{}]},
        {"name": "x", "include": [{"product": 1, "group": "Chips"}]},
        {"name": "x", "include": [{"group": "Chips", "family": "Apéritif"}]},
        {"name": "x", "include": [{"group": "Chips"}], "words": ["a"] * 6},
        {"name": "x", "include": [{"group": "Chips"}], "words": ["x" * 41]},
        {"name": " ", "include": [{"group": "Chips"}]},
        {"name": "x", "include": [{"group": "Chips"}] * 21},
    ):
        assert (await client.post(PREVIEW, json=wrong)).status_code == 422, wrong


@pytest.mark.asyncio
async def test_basket_prices_and_shared_baskets_take_selections(setup):
    client, connection, ids = setup
    selection = {"kind": "selection", "name": "Jus de fruits bio", "include": [{"family": "Jus de fruits"}], "words": ["bio"]}
    priced = await client.post("/api/v2/basket/prices", headers=ANA, json={"items": [selection, {"kind": "group", "name": "Chips"}]})
    assert priced.status_code == 200, priced.text
    first, second = priced.json()["lines"]
    assert set(first["product_ids"]) == {ids["Pur jus d'orange bio"], ids["Jus d'orange bio"], ids["Nectar de pomme bio"]}
    assert second["product_ids"] == [ids["Chips nature"]] and priced.json()["cost"] == 2

    created = await client.post(SHARED, headers=ANA, json={"name": "Courses", "lines": [
        {"line": selection, "quantity": {"amount": "2", "unit": "l"}}]})
    assert created.status_code == 201, created.text
    state = created.json()
    line = state["lines"][0]
    assert line["kind"] == "selection" and line["label"] == "Jus de fruits bio"
    assert line["spec"] == {"include": [{"family": "Jus de fruits"}], "exclude": [], "words": ["bio"]}
    basket_id = state["id"]
    fetched = await client.post(f"{SHARED}/{basket_id}/prices", headers=ANA)
    assert fetched.status_code == 200, fetched.text
    assert len(fetched.json()["prices"]["content"]["lines"][0]["product_ids"]) == 3
    # The same name is one line; changing a selection is removing it and adding it again.
    changed = await client.post(f"{SHARED}/{basket_id}/changes", headers=ANA, json={"ops": [
        {"op": "remove", "line": selection},
        {"op": "add", "line": {**selection, "words": [], "exclude": [{"group": "Nectar de pomme"}]}}]})
    assert changed.status_code == 200, changed.text
    spec = (await client.get(f"{SHARED}/{basket_id}", headers=ANA)).json()["lines"][0]["spec"]
    assert spec == {"include": [{"family": "Jus de fruits"}], "exclude": [{"group": "Nectar de pomme"}], "words": []}
    assert await connection.fetchval("SELECT count(*) FROM v2_shared_basket_lines WHERE basket_id=$1", basket_id) == 1


@pytest.mark.asyncio
async def test_the_outline_is_a_nested_tree_filtered_by_words(setup):
    client, _connection, _ids = setup
    tree = (await client.get("/api/v2/catalogue/outline")).json()
    assert tree["groups"] == 6 and tree["truncated"] is False
    boissons = next(item for item in tree["departments"] if item["name"] == "Boissons")
    juices = next(item for item in boissons["families"] if item["name"] == "Jus de fruits")
    assert [scope["name"] for scope in juices["scopes"]] == ["Jus d'orange"]
    assert {group["name"]: group["products"] for group in juices["scopes"][0]["groups"]} == {
        "Jus d'orange à base de concentré": 1, "Jus d'orange bio": 2}
    assert juices["groups"] == [{"name": "Nectar de pomme", "products": 2}]
    # Words match any level, without accents; every word must appear.
    found = (await client.get("/api/v2/catalogue/outline", params={"q": "ORANGE a base"})).json()
    assert found["groups"] == 1
    assert found["departments"][0]["families"][0]["scopes"][0]["groups"] == [{"name": "Jus d'orange à base de concentré", "products": 1}]
    assert (await client.get("/api/v2/catalogue/outline", params={"q": "epicerie"})).json()["groups"] == 1
    limited = (await client.get("/api/v2/catalogue/outline", params={"limit": 2})).json()
    assert limited["groups"] == 2 and limited["truncated"] is True
