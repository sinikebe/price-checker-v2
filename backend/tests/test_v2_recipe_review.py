"""Recipes never reach public readers before a deliberate review decision."""

from __future__ import annotations

import httpx
import pytest

from app.api.v2 import recipe_submissions, recipes
from app.db.v2_migrations import connect_v2
from app.main_v2 import app
from conftest import disposable_database, requires_v2_db

pytestmark = requires_v2_db


@pytest.mark.asyncio
async def test_recipe_creation_and_edits_wait_for_approval(monkeypatch):
    async with disposable_database("v2_recipe_review_") as config:
        connection = await connect_v2(config)
        try:
            author_id = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES('author','author','test','confirmed') RETURNING id"
            )
            admin_id = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES('reviewer','reviewer','test','admin') RETURNING id"
            )
            users = {
                "author": {"id": author_id, "role": "confirmed", "username": "author"},
                "admin": {"id": admin_id, "role": "admin", "username": "reviewer"},
            }

            async def fake_connect():
                return await connect_v2(config)

            async def fake_user(_connection, request):
                return users.get(request.headers.get("x-test-user"))

            for module in (recipes, recipe_submissions):
                monkeypatch.setattr(module, "_connect", fake_connect)
                monkeypatch.setattr(module, "_current_user", fake_user)
            payload = {
                "title": "Private soup", "description": "First version", "base_servings": "2",
                "prep_minutes": 10, "cook_minutes": 5, "steps": ["Mix"],
                "ingredients": [{"label": "Water", "amount": "1", "unit": "l",
                                 "group_name": "Water", "note": "", "optional": False}],
            }
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="https://test"
            ) as client:
                base_path = "/api/v2/recipes"
                assert (await client.post(base_path, json=payload)).status_code == 401
                created = await client.post(base_path, json=payload, headers={"x-test-user": "author"})
                assert created.status_code == 202, created.text
                submission_id = created.json()["submission_id"]
                assert (await client.get(base_path)).json()["items"] == []
                assert (await client.get(base_path + "/submissions/mine")).status_code == 401
                assert (await client.get(base_path + "/submissions/review", headers={"x-test-user": "author"})).status_code == 403
                queue = (await client.get(base_path + "/submissions/review", headers={"x-test-user": "admin"})).json()
                assert queue[0]["payload"]["title"] == "Private soup"
                assert (await client.post(base_path + f"/submissions/{submission_id}/approve", headers={"x-test-user": "author"})).status_code == 403
                approved = await client.post(base_path + f"/submissions/{submission_id}/approve", headers={"x-test-user": "admin"})
                assert approved.status_code == 200, approved.text
                recipe_id = approved.json()["recipe"]["id"]
                assert approved.json()["recipe"]["title"] == "Private soup"
                assert (await client.get(base_path)).json()["total"] == 1
                update = {**payload, "title": "Revised soup", "revision": 1}
                proposal = await client.put(base_path + f"/{recipe_id}", json=update, headers={"x-test-user": "author"})
                assert proposal.status_code == 202, proposal.text
                edit_id = proposal.json()["submission_id"]
                assert (await client.get(base_path + f"/{recipe_id}")).json()["title"] == "Private soup"
                assert (await client.put(base_path + f"/{recipe_id}", json=update, headers={"x-test-user": "author"})).status_code == 409
                assert (await client.post(base_path + f"/submissions/{edit_id}/reject", headers={"x-test-user": "admin"})).status_code == 200
                assert (await client.get(base_path + f"/{recipe_id}")).json()["title"] == "Private soup"
                resubmitted = await client.put(base_path + f"/submissions/{edit_id}", json={**payload, "title": "Final soup", "revision": 1}, headers={"x-test-user": "author"})
                assert resubmitted.status_code == 200, resubmitted.text
                assert resubmitted.json()["revision"] == 2
                stale = await client.put(base_path + f"/submissions/{edit_id}",
                    json={**payload, "title": "Stale soup", "revision": 1},
                    headers={"x-test-user": "author"})
                assert stale.status_code == 409
                assert (await client.get(base_path + f"/{recipe_id}")).json()["title"] == "Private soup"
                approved_edit = await client.post(base_path + f"/submissions/{edit_id}/approve", headers={"x-test-user": "admin"})
                assert approved_edit.status_code == 200, approved_edit.text
                assert (await client.get(base_path + f"/{recipe_id}")).json()["title"] == "Final soup"
                assert (await client.get(base_path + f"/{recipe_id}")).json()["revision"] == 2
                assert (await client.get(base_path + f"/submissions/{edit_id}", headers={"x-test-user": "author"})).headers["cache-control"] == "private, no-store"
        finally:
            await connection.close()
