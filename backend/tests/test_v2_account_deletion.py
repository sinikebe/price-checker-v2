"""Account erasure retains published contributions without an author identity."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from app.api.v2 import auth, setup
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


@pytest_asyncio.fixture
async def isolated_db(monkeypatch):
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    name = "v2_erase_" + secrets.token_hex(5)
    root = await connect_v2(base)
    try:
        await root.execute('CREATE DATABASE "' + name + '"')
    finally:
        await root.close()
    config = {**base, "database": name}
    try:
        await migrate_v2(config)
        monkeypatch.setattr(auth, "_read_config", lambda: config)
        monkeypatch.setattr(auth, "_access_code", lambda: "ci-erasure-key")
        monkeypatch.setattr(setup, "_read_config", lambda: config)
        yield config
    finally:
        root = await connect_v2(base)
        try:
            await root.execute('DROP DATABASE "' + name + '" WITH (FORCE)')
        finally:
            await root.close()


async def session(connection, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    await connection.execute(
        "INSERT INTO v2_sessions(token_hash,user_id,expires_at) "
        "VALUES($1,$2,now()+interval '1 hour')",
        hashlib.sha256(token.encode()).hexdigest(), user_id,
    )
    return token


@pytest.mark.asyncio
async def test_delete_account_preserves_anonymous_public_content(isolated_db):
    connection = await connect_v2(isolated_db)
    password = "test-account-password"
    try:
        assert await connection.fetchval("SELECT to_regclass('v2_user_baskets')") is None
        admin_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('admin','admin',$1,'admin') RETURNING id",
            await auth._hash_password(password),
        )
        await connection.execute(
            "UPDATE v2_installation SET admin_user_id=$1 WHERE singleton=true", admin_id
        )
        user_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('private_writer','private_writer',$1,'visitor') RETURNING id",
            await auth._hash_password(password),
        )
        other_id = await connection.fetchval(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('other_writer','other_writer',$1,'visitor') RETURNING id",
            await auth._hash_password(password),
        )
        first_token = await session(connection, user_id)
        second_token = await session(connection, user_id)
        admin_token = await session(connection, admin_id)
        product_id = await connection.fetchval(
            "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
            json.dumps({"name": "Published food", "brand": "CI", "quantity": "100 g"}),
        )
        published_draft_id = await connection.fetchval(
            "INSERT INTO v2_product_drafts(author_id,data,status,approved_by) "
            "VALUES($1,$2::jsonb,'approved',$3) RETURNING id",
            user_id, json.dumps({"name": "Published food"}), admin_id,
        )
        await connection.execute(
            "INSERT INTO v2_product_drafts(author_id,data) "
            "VALUES($1,'{\"name\":\"Private draft\"}'::jsonb)", user_id,
        )
        event_id = await connection.fetchval(
            "INSERT INTO v2_product_events"
            "(product_id,draft_id,actor_id,event_type,after_data) "
            "VALUES($1,$2,$3,'created',$4::jsonb) RETURNING id",
            product_id, published_draft_id, user_id,
            json.dumps({"name": "Published food"}),
        )
        recipe_id = await connection.fetchval(
            "INSERT INTO v2_recipes(author_id,title,base_servings,steps) "
            "VALUES($1,'Published recipe',2,'[\"Mix\"]'::jsonb) RETURNING id",
            user_id,
        )
        await connection.execute(
            "INSERT INTO v2_recipe_ingredients(recipe_id,position,label,group_name) "
            "VALUES($1,0,'Flour','Flour')", recipe_id,
        )
        await connection.execute(
            "INSERT INTO v2_recipes(author_id,title,base_servings,steps) "
            "VALUES($1,'Other recipe',2,'[\"Mix\"]'::jsonb)", other_id,
        )
        await connection.execute(
            "INSERT INTO v2_retailers(code,name) VALUES('ci','CI')"
        )
        await connection.execute(
            "INSERT INTO v2_stores(retailer_id,name) "
            "SELECT id,'CI store' FROM v2_retailers WHERE code='ci'"
        )
        price_draft_id = await connection.fetchval(
            "INSERT INTO v2_price_drafts"
            "(author_id,product_id,retailer_id,store_id,entry_kind,price,observed_at,"
            "status,reviewed_by,reviewed_at) "
            "SELECT $1,$2,r.id,s.id,'manual',3.45,now(),'approved',$3,now() "
            "FROM v2_retailers r JOIN v2_stores s ON s.retailer_id=r.id "
            "WHERE r.code='ci' RETURNING id",
            user_id, product_id, admin_id,
        )
        await connection.execute(
            "INSERT INTO v2_price_drafts"
            "(author_id,product_id,retailer_id,store_id,entry_kind,price,observed_at) "
            "SELECT $1,$2,r.id,s.id,'manual',4.56,now() "
            "FROM v2_retailers r JOIN v2_stores s ON s.retailer_id=r.id "
            "WHERE r.code='ci'", user_id, product_id,
        )
        observation_id = await connection.fetchval(
            "INSERT INTO v2_price_observations"
            "(product_id,retailer_id,store_id,source,contributor_id,price_draft_id,"
            "approved_by,approved_at,price,observed_at) "
            "SELECT $1,r.id,s.id,'manual',$2,$3,$4,now(),3.45,now() "
            "FROM v2_retailers r JOIN v2_stores s ON s.retailer_id=r.id "
            "WHERE r.code='ci' RETURNING id",
            product_id, user_id, price_draft_id, admin_id,
        )
        await connection.execute(
            "INSERT INTO v2_content_reports(kind,content_id,reporter_id,reason) "
            "VALUES('product',$1,$2,'Private report')", product_id, user_id,
        )
        await connection.execute(
            "INSERT INTO v2_recipe_submissions(author_id,payload) VALUES($1,$2::jsonb)",
            user_id, json.dumps({"title": "Pending private recipe"}),
        )
        transport = httpx.ASGITransport(app=app, client=("192.0.2.20", 443))
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            client.cookies.set("pc_v2_session", first_token, path="/api/v2")
            recipe_path = f"/api/v2/recipes/{recipe_id}"
            public = (await client.get(recipe_path)).json()
            assert "author" not in public and "author_id" not in public
            assert len(public["created_at"]) == len(public["updated_at"]) == 10
            own_access = await client.get(recipe_path + "/access")
            assert own_access.json() == {"can_edit": True}
            assert own_access.headers["cache-control"] == "private, no-store"
            client.cookies.set("pc_v2_session", admin_token, path="/api/v2")
            assert (await client.get(recipe_path + "/access")).json() == {"can_edit": True}
            client.cookies.set("pc_v2_session", first_token, path="/api/v2")
            exported = await client.get("/api/v2/account/export")
            assert exported.status_code == 200
            assert exported.json()["recipe_submissions"][0]["payload"]["title"] == "Pending private recipe"
            wrong = await client.request(
                "DELETE", "/api/v2/account", json={"password": "incorrect"}
            )
            assert wrong.status_code == 401
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_users WHERE id=$1", user_id
            ) == 1
            deleted = await client.request(
                "DELETE", "/api/v2/account", json={"password": password}
            )
            assert deleted.status_code == 204, deleted.text
            assert (await client.get("/api/v2/auth/status")).json()["user"] is None
            client.cookies.set("pc_v2_session", second_token, path="/api/v2")
            assert (await client.get("/api/v2/account/export")).status_code == 401
            recipe = (await client.get(f"/api/v2/recipes/{recipe_id}")).json()
            assert "author" not in recipe and "author_id" not in recipe
            assert recipe["revision"] == 2
            assert len(recipe["ingredients"]) == 1
            history = (await client.get(
                f"/api/v2/products/{product_id}/history"
            )).json()
            assert history[0]["id"] == event_id
            assert "actor" not in history[0]
            prices = (await client.get(
                f"/api/v2/prices/products/{product_id}"
            )).json()["observations"]
            assert len(prices) == 1 and prices[0]["id"] == observation_id
            assert (await client.get(f"/api/v2/products/{product_id}")).status_code == 200
            client.cookies.set("pc_v2_session", admin_token, path="/api/v2")
            assert (await client.request(
                "DELETE", "/api/v2/account", json={"password": password}
            )).status_code == 409
        assert await connection.fetchval(
            "SELECT count(*) FROM v2_users WHERE id=$1", user_id
        ) == 0
        assert await connection.fetchval(
            "SELECT count(*) FROM v2_sessions WHERE user_id=$1", user_id
        ) == 0
        assert await connection.fetchval(
            "SELECT count(*) FROM v2_product_drafts WHERE author_id=$1", user_id
        ) == 0
        assert await connection.fetchval(
            "SELECT count(*) FROM v2_price_drafts WHERE author_id=$1", user_id
        ) == 0
        assert await connection.fetchval(
            "SELECT count(*) FROM v2_recipe_submissions WHERE author_id=$1", user_id
        ) == 0
        assert await connection.fetchval(
            "SELECT count(*) FROM v2_content_reports WHERE reporter_id=$1", user_id
        ) == 0
        assert await connection.fetchval(
            "SELECT draft_id FROM v2_product_events WHERE id=$1", event_id
        ) is None
        assert await connection.fetchval(
            "SELECT contributor_id FROM v2_price_observations WHERE id=$1",
            observation_id,
        ) is None
        assert await connection.fetchval(
            "SELECT price_draft_id FROM v2_price_observations WHERE id=$1",
            observation_id,
        ) is None
        assert await connection.fetchval(
            "SELECT count(*) FROM v2_users WHERE id IN ($1,$2)", admin_id, other_id
        ) == 2
        await connection.execute(
            "INSERT INTO v2_users(username,username_key,password_hash,role) "
            "VALUES('private_writer','private_writer','unused','visitor')"
        )
    finally:
        await connection.close()
