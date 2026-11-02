"""A private recipe is its author's alone: saved at once, never public until a review approves it."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

import httpx
import pytest

from app.api.v2 import moderation, private_recipes, recipe_submissions, recipes
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)

PAYLOAD = {
    "title": "Soupe de mamie", "description": "Notre version", "base_servings": "4",
    "prep_minutes": 15, "cook_minutes": 30, "steps": ["Couper", "Cuire"],
    "ingredients": [{"label": "Poireaux", "amount": "500", "unit": "g",
                     "group_name": "Poireaux", "note": "", "optional": False}],
}


@pytest.fixture
async def setup(monkeypatch):
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    root = await connect_v2(base)
    database = "v2_private_recipes_" + secrets.token_hex(5)
    await root.execute('CREATE DATABASE "' + database + '"')
    await root.close()
    config = {**base, "database": database}
    await migrate_v2(config)
    connection = await connect_v2(config)
    users = {}
    for name, role in (("author", "confirmed"), ("other", "confirmed"), ("admin", "admin")):
        user_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES($1,$1,'test',$2) RETURNING id", name, role,
        )
        users[name] = {"id": user_id, "role": role, "username": name}

    async def fake_connect():
        return await connect_v2(config)

    async def fake_user(_connection, request):
        return users.get(request.headers.get("x-test-user"))

    for module in (recipes, recipe_submissions, private_recipes, moderation):
        monkeypatch.setattr(module, "_connect", fake_connect)
    for module in (recipes, recipe_submissions, moderation):
        monkeypatch.setattr(module, "_current_user", fake_user)
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


def who(name: str) -> dict:
    return {"x-test-user": name}


async def pwa_revision(connection) -> int:
    return await connection.fetchval(
        "SELECT revision FROM v2_pwa_versions WHERE collection='recipes'"
    )


@pytest.mark.asyncio
async def test_a_private_recipe_is_saved_at_once_and_seen_by_its_author_only(setup):
    client, connection, _users = setup
    path = "/api/v2/recipes/private"
    before = await pwa_revision(connection)
    assert (await client.post(path, json=PAYLOAD)).status_code == 401
    created = await client.post(path, json=PAYLOAD, headers=who("author"))
    assert created.status_code == 201, created.text
    recipe = created.json()
    assert recipe["private"] is True and recipe["publication"] is None
    assert recipe["title"] == "Soupe de mamie" and len(recipe["ingredients"]) == 1
    assert created.headers["cache-control"] == "private, no-store"
    recipe_id = recipe["id"]
    # No review and no credits for a private recipe.
    assert await connection.fetchval("SELECT count(*) FROM v2_recipe_submissions") == 0
    assert await connection.fetchval("SELECT count(*) FROM v2_credit_rewards") == 0
    # Offline copies of public recipes are not invalidated by a private save.
    assert await pwa_revision(connection) == before

    mine = await client.get(path, headers=who("author"))
    assert [item["id"] for item in mine.json()["items"]] == [recipe_id]
    assert mine.json()["items"][0]["ingredient_count"] == 1
    assert mine.headers["cache-control"] == "private, no-store"
    assert (await client.get(path, headers=who("other"))).json()["items"] == []

    # Nobody else reads it, not even an administrator, and public routes do not know it.
    for name in ("other", "admin"):
        assert (await client.get(f"{path}/{recipe_id}", headers=who(name))).status_code == 404
        assert (await client.delete(f"{path}/{recipe_id}", headers=who(name))).status_code == 404
    public = "/api/v2/recipes"
    assert (await client.get(public)).json() == {"items": [], "total": 0, "page": 1, "page_size": 20}
    assert (await client.get(f"{public}/{recipe_id}")).status_code == 404
    assert (await client.get(f"{public}/{recipe_id}/access", headers=who("author"))).status_code == 404
    update = {**PAYLOAD, "revision": 1}
    assert (await client.put(f"{public}/{recipe_id}", json=update, headers=who("author"))).status_code == 404
    assert (await client.delete(f"{public}/{recipe_id}", headers=who("admin"))).status_code == 404
    report = await client.post("/api/v2/moderation/reports", headers=who("other"), json={
        "kind": "recipe", "content_id": recipe_id, "report_type": "general",
        "reason": "Contenu à vérifier"})
    assert report.status_code == 404, report.text

    # The author changes it directly, with the usual revision check.
    changed = await client.put(f"{path}/{recipe_id}", headers=who("author"),
                               json={**update, "title": "Soupe du dimanche"})
    assert changed.status_code == 200, changed.text
    assert changed.json()["revision"] == 2 and changed.json()["title"] == "Soupe du dimanche"
    stale = await client.put(f"{path}/{recipe_id}", headers=who("author"), json=update)
    assert stale.status_code == 409
    assert (await client.get(f"{path}/{recipe_id}", headers=who("author"))).json()["revision"] == 2
    assert await pwa_revision(connection) == before

    removed = await client.delete(f"{path}/{recipe_id}", headers=who("author"))
    assert removed.status_code == 204
    assert (await client.get(f"{path}/{recipe_id}", headers=who("author"))).status_code == 404
    assert await pwa_revision(connection) == before


@pytest.mark.asyncio
async def test_publishing_a_private_recipe_goes_through_review(setup):
    client, connection, users = setup
    path = "/api/v2/recipes/private"
    recipe_id = (await client.post(path, json=PAYLOAD, headers=who("author"))).json()["id"]
    assert (await client.post(f"{path}/{recipe_id}/publish", json={"revision": 1},
                              headers=who("other"))).status_code == 404
    assert (await client.post(f"{path}/{recipe_id}/publish", json={"revision": 2},
                              headers=who("author"))).status_code == 409
    asked = await client.post(f"{path}/{recipe_id}/publish", json={"revision": 1},
                              headers=who("author"))
    assert asked.status_code == 202, asked.text
    submission_id = asked.json()["submission_id"]
    assert (await client.post(f"{path}/{recipe_id}/publish", json={"revision": 1},
                              headers=who("author"))).status_code == 409
    detail = (await client.get(f"{path}/{recipe_id}", headers=who("author"))).json()
    assert detail["publication"] == {"submission_id": submission_id, "status": "pending", "revision": 1}
    assert (await client.get(path, headers=who("author"))).json()["items"][0]["publication"] == "pending"
    # While the review waits, the recipe stays private and unchanged.
    locked = await client.put(f"{path}/{recipe_id}", headers=who("author"),
                              json={**PAYLOAD, "title": "Autre", "revision": 1})
    assert locked.status_code == 409
    assert (await client.get(f"/api/v2/recipes/{recipe_id}")).status_code == 404

    queue = (await client.get("/api/v2/recipes/submissions/review", headers=who("admin"))).json()
    assert [(item["id"], item["publishes_private"]) for item in queue] == [(submission_id, True)]
    assert queue[0]["payload"]["title"] == "Soupe de mamie"
    before = await pwa_revision(connection)
    approved = await client.post(f"/api/v2/recipes/submissions/{submission_id}/approve",
                                 headers=who("admin"))
    assert approved.status_code == 200, approved.text
    assert approved.json()["recipe"]["id"] == recipe_id
    assert approved.json()["recipe"]["private"] is False
    # Now public: listed, cached offline, edited through review, credited as a validated contribution.
    listed = (await client.get("/api/v2/recipes")).json()
    assert [item["id"] for item in listed["items"]] == [recipe_id]
    assert await pwa_revision(connection) > before
    assert (await client.get(f"{path}/{recipe_id}", headers=who("author"))).status_code == 404
    assert (await client.get(path, headers=who("author"))).json()["items"] == []
    assert await connection.fetchval(
        "SELECT credits FROM v2_credit_rewards WHERE user_id=$1 AND kind='recipe'",
        users["author"]["id"],
    ) == 10


@pytest.mark.asyncio
async def test_a_refused_publication_can_be_revised_or_asked_again(setup):
    client, _connection, _users = setup
    path = "/api/v2/recipes/private"
    recipe_id = (await client.post(path, json=PAYLOAD, headers=who("author"))).json()["id"]
    submission_id = (await client.post(f"{path}/{recipe_id}/publish", json={"revision": 1},
                                       headers=who("author"))).json()["submission_id"]
    assert (await client.post(f"/api/v2/recipes/submissions/{submission_id}/reject",
                              headers=who("admin"))).status_code == 200
    detail = (await client.get(f"{path}/{recipe_id}", headers=who("author"))).json()
    assert detail["publication"]["status"] == "rejected"
    # A refused request no longer locks the recipe.
    changed = await client.put(f"{path}/{recipe_id}", headers=who("author"),
                               json={**PAYLOAD, "title": "Soupe corrigée", "revision": 1})
    assert changed.status_code == 200, changed.text
    # The refused copy is stale now; a new request carries the current version.
    stale = await client.put(f"/api/v2/recipes/submissions/{submission_id}", headers=who("author"),
                             json={**PAYLOAD, "revision": 1})
    assert stale.status_code == 409
    again = await client.post(f"{path}/{recipe_id}/publish", json={"revision": 2},
                              headers=who("author"))
    assert again.status_code == 202, again.text
    queue = (await client.get("/api/v2/recipes/submissions/review", headers=who("admin"))).json()
    assert queue[0]["payload"]["title"] == "Soupe corrigée"


@pytest.mark.asyncio
async def test_private_recipes_are_bounded_per_account(setup, monkeypatch):
    client, _connection, _users = setup
    monkeypatch.setattr(private_recipes, "MAX_PRIVATE_RECIPES", 2)
    path = "/api/v2/recipes/private"
    for _ in range(2):
        assert (await client.post(path, json=PAYLOAD, headers=who("author"))).status_code == 201
    refused = await client.post(path, json=PAYLOAD, headers=who("author"))
    assert refused.status_code == 429
    assert "2 recettes privées" in refused.json()["detail"]
    assert (await client.post(path, json=PAYLOAD, headers=who("other"))).status_code == 201
