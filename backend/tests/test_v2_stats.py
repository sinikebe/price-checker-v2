"""Request counters, the page beacon and the statistics screen: numbers per route, no personal data."""
from __future__ import annotations

import json
import os
import secrets
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from app.api.v2 import stats as stats_api
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app
from app.services import v2_request_stats as stats
from fastapi import HTTPException

NOW = datetime(2026, 11, 1, 10, 7, 31, tzinfo=UTC)
needs_db = pytest.mark.skipif(not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required")


@pytest.fixture(autouse=True)
def clean_counters():
    stats._requests.clear()
    stats._pages.clear()
    stats._clients.clear()
    yield
    stats._requests.clear()
    stats._pages.clear()
    stats._clients.clear()


def test_requests_are_counted_by_route_method_status_class_and_five_minute_bucket():
    stats.record_request("/api/v2/products/{product_id}", "GET", 200, 10, NOW)
    stats.record_request("/api/v2/products/{product_id}", "GET", 200, 30, NOW + timedelta(minutes=1))
    stats.record_request("/api/v2/products/{product_id}", "GET", 404, 5, NOW)
    stats.record_request("/api/v2/products/{product_id}", "GET", 200, 7, NOW + timedelta(minutes=5))
    bucket = datetime(2026, 11, 1, 10, 5, tzinfo=UTC)
    assert stats._requests[(bucket, "/api/v2/products/{product_id}", "GET", 2)] == [2, 40, 30]
    assert stats._requests[(bucket, "/api/v2/products/{product_id}", "GET", 4)] == [1, 5, 5]
    assert stats._requests[(bucket + timedelta(minutes=5), "/api/v2/products/{product_id}", "GET", 2)] == [1, 7, 7]


def test_the_observability_routes_and_non_requests_are_not_counted():
    for route in ("/api/v2/stats", "/api/v2/stats/page", "/api/v2/logs"):
        stats.record_request(route, "GET", 200, 1, NOW)
    stats.record_request("/api/v2/x", "OPTIONS", 200, 1, NOW)
    stats.record_request("/api/v2/x", "HEAD", 200, 1, NOW)
    stats.record_request("/api/v2/x", "GET", 99, 1, NOW)
    assert stats._requests == {}


def test_memory_is_bounded_when_the_database_is_away(monkeypatch):
    monkeypatch.setattr(stats, "MAX_PENDING", 2)
    for number in range(5):
        stats.record_request(f"/api/v2/r{number}", "GET", 200, 1, NOW)
    assert len(stats._requests) == 2
    stats.record_request("/api/v2/r0", "GET", 200, 1, NOW)  # an existing key is still counted
    assert stats._requests[(datetime(2026, 11, 1, 10, 5, tzinfo=UTC), "/api/v2/r0", "GET", 2)][0] == 2


def test_routes_fall_in_groups_by_prefix():
    assert [stats.group_of(route) for route in (
        "/api/v2/basket/prices", "/api/v2/prices/products/{product_id}", "/api/v2/products/{product_id}", "/api/v2/products",
        "/api/v2/catalogue/suggest", "/api/v2/recipes/{recipe_id}", "/api/v2/stores", "/api/v2/auth/login",
        "/api/v2/account/export", "/api/v2/connector-stores/{connector_id}/products/refresh", "/api/v2/productsx", "unmatched")] == [
        "basket", "prices", "products", "products", "catalogue", "recipes", "stores", "accounts", "accounts", "connectors", "other", "other"]


def test_only_pages_from_the_fixed_list_are_counted():
    assert stats.record_page("basket", True, NOW) and stats.record_page("basket", False, NOW)
    assert not stats.record_page("/v2/produits/12?name=Jean", True, NOW)
    assert not stats.record_page("Jean Dupont", False, NOW)
    assert stats._pages == {(datetime(2026, 11, 1, 10, 5, tzinfo=UTC), "basket"): [2, 1]}


def test_the_beacon_limiter_is_per_client_in_memory_and_resets_each_minute():
    assert all(stats.allow_beacon("a", per_minute=3, now=100.0) for _ in range(3))
    assert not stats.allow_beacon("a", per_minute=3, now=130.0)
    assert stats.allow_beacon("b", per_minute=3, now=130.0)
    assert stats.allow_beacon("a", per_minute=3, now=161.0)


@pytest.mark.asyncio
async def test_the_middleware_never_records_a_url():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
        await client.get("/api/v2/definitely-not-a-route/jean.dupont@example.org?token=secret")
        await client.get("/health")
        await client.options("/api/v2/openapi.json")
    assert {(route, method, status) for (_bucket, route, method, status) in stats._requests} == {(stats.UNMATCHED, "GET", 4)}
    assert "jean" not in json.dumps([key[1] for key in stats._requests])


@pytest.mark.asyncio
async def test_a_template_route_is_counted_whatever_the_id(monkeypatch):
    async def missing(*_args, **_kwargs):
        raise HTTPException(status_code=404)
    from app.api.v2 import products
    monkeypatch.setattr(products, "_connect", missing)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="https://test") as client:
        await client.get("/api/v2/products/12")
        await client.get("/api/v2/products/987654")
    routes = {route for (_b, route, _m, _s) in stats._requests}
    assert routes == {"/api/v2/products/{product_id}"}
    assert sum(values[0] for values in stats._requests.values()) == 2


@pytest_asyncio.fixture
async def config():
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_stats_" + secrets.token_hex(5)
    admin = await connect_v2(base)
    try:
        await admin.execute('CREATE DATABASE "' + database + '"')
    finally:
        await admin.close()
    configured = {**base, "database": database}
    try:
        await migrate_v2(configured)
        yield configured
    finally:
        admin = await connect_v2(base)
        try:
            await admin.execute('DROP DATABASE "' + database + '" WITH (FORCE)')
        finally:
            await admin.close()


@pytest_asyncio.fixture
async def db(config):
    connection = await connect_v2(config)
    try:
        yield connection
    finally:
        await connection.close()


@pytest.fixture
def served(monkeypatch, config):
    async def connect():
        return await connect_v2(config)

    async def allowed(_request):
        return None
    monkeypatch.setattr(stats_api, "_connect", connect)
    monkeypatch.setattr(stats_api, "_require_admin", allowed)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test")


@pytest.mark.asyncio
@needs_db
async def test_a_flush_adds_to_existing_buckets_and_failures_keep_the_counts(db):
    stats.record_request("/api/v2/x", "GET", 200, 10)
    stats.record_page("home", True)
    assert await stats.flush(db) == 2
    stats.record_request("/api/v2/x", "GET", 200, 30)
    stats.record_request("/api/v2/x", "GET", 500, 5)
    assert await stats.flush(db) == 2
    row = await db.fetchrow("SELECT requests,duration_ms_sum,duration_ms_max FROM v2_request_stats WHERE status_class=2")
    assert tuple(row) == (2, 40, 30)
    assert await db.fetchval("SELECT count(*) FROM v2_request_stats") == 2
    assert await db.fetchval("SELECT views FROM v2_page_stats WHERE page='home'") == 1
    assert await stats.flush(db) == 0
    stats.record_request("/api/v2/y", "GET", 200, 1)
    await db.execute("ALTER TABLE v2_request_stats RENAME TO v2_request_stats_away")
    with pytest.raises(Exception, match="v2_request_stats"):
        await stats.flush(db)
    assert sum(values[0] for values in stats._requests.values()) == 1, "kept for the next flush"


async def seed_requests(db, rows):
    await db.executemany("INSERT INTO v2_request_stats VALUES($1,$2,$3,$4,$5,$6,$7)", rows)


@pytest.mark.asyncio
@needs_db
async def test_the_statistics_sort_endpoints_by_requests_and_summarise_each_group(db, served):
    now = datetime.now(UTC)
    recent, hour_old, day_old, week_old, ancient = (now - timedelta(minutes=10), now - timedelta(minutes=90), now - timedelta(hours=5),
                                                    now - timedelta(days=3), now - timedelta(days=20))
    await seed_requests(db, [
        (stats.bucket_of(recent), "/api/v2/basket/prices", "POST", 2, 4, 400, 150),
        (stats.bucket_of(recent), "/api/v2/basket/prices", "POST", 4, 1, 3, 3),
        (stats.bucket_of(recent), "/api/v2/prices/products/{product_id}", "GET", 2, 30, 300, 40),
        (stats.bucket_of(hour_old), "/api/v2/prices/products/{product_id}", "GET", 2, 10, 100, 20),
        (stats.bucket_of(hour_old), "/api/v2/products/{product_id}", "GET", 2, 20, 200, 30),
        (stats.bucket_of(hour_old), "/api/v2/products/{product_id}", "GET", 5, 2, 20, 30),
        (stats.bucket_of(day_old), "/api/v2/catalogue/suggest", "GET", 2, 7, 70, 12),
        (stats.bucket_of(week_old), "/api/v2/recipes", "GET", 2, 5, 50, 9),
        (stats.bucket_of(ancient), "/api/v2/stores", "GET", 2, 9, 90, 9),
    ])
    async with served as client:
        day = (await client.get("/api/v2/stats", params={"period": "24h"})).json()
        assert day["period"] == "24h" and day["requests"] == {"total": 4 + 1 + 40 + 22 + 7, "client_errors": 1, "server_errors": 2}
        assert [(e["method"], e["route"], e["requests"]) for e in day["endpoints"]] == [
            ("GET", "/api/v2/prices/products/{product_id}", 40), ("GET", "/api/v2/products/{product_id}", 22),
            ("GET", "/api/v2/catalogue/suggest", 7), ("POST", "/api/v2/basket/prices", 5)]
        top = day["endpoints"][0]
        assert (top["average_ms"], top["max_ms"]) == (10, 40) and abs(top["per_hour"] - 40 / day["hours"]) < 0.01
        assert day["groups"]["basket"] == {"requests": 5, "errors": 1}
        assert day["groups"]["products"] == {"requests": 22, "errors": 2}
        assert day["groups"]["prices"]["requests"] == 40 and day["groups"]["catalogue"]["requests"] == 7
        hour = (await client.get("/api/v2/stats", params={"period": "1h"})).json()
        assert [e["route"] for e in hour["endpoints"]] == ["/api/v2/prices/products/{product_id}", "/api/v2/basket/prices"]
        assert hour["requests"]["total"] == 35, "only the last hour: the older buckets are out"
        week = (await client.get("/api/v2/stats", params={"period": "7d"})).json()
        assert week["groups"]["recipes"]["requests"] == 5 and "stores" not in week["groups"]
        month = (await client.get("/api/v2/stats", params={"period": "30d"})).json()
        assert month["groups"]["stores"]["requests"] == 9
        assert month["recording_since"] is not None and month["since"] < week["since"]
        assert (await client.get("/api/v2/stats", params={"period": "1y"})).status_code == 422


@pytest.mark.asyncio
@needs_db
async def test_contributions_visits_and_accounts_are_counts_from_existing_timestamps(db, served):
    now = datetime.now(UTC)
    old = now - timedelta(days=45)
    users = [await db.fetchval("INSERT INTO v2_users(username,username_key,password_hash,role,created_at) VALUES($1,$1,'x','confirmed',$2) RETURNING id",
                               name, when) for name, when in (("ana", now), ("ben", now - timedelta(hours=2)), ("old", old))]
    retailer = await db.fetchval("INSERT INTO v2_retailers(code,name) VALUES('t','T') RETURNING id")
    shop = await db.fetchval("INSERT INTO v2_stores(retailer_id,name) VALUES($1,'S') RETURNING id", retailer)
    product = await db.fetchval("INSERT INTO v2_products(data) VALUES('{\"name\":\"Lait\"}'::jsonb) RETURNING id")
    for status, created in (("draft", now), ("approved", now), ("rejected", old)):
        await db.execute("INSERT INTO v2_product_drafts(product_id,author_id,data,base_revision,status,created_at,approved_at) "
                         "VALUES($1,$2,'{\"name\":\"x\"}'::jsonb,1,$3,$4,$5)", product, users[0], status, created, now if status == "approved" else None)
    for number, source in enumerate(("manual", "manual", "bookmarklet", "third_party")):
        await db.execute("INSERT INTO v2_price_observations(product_id,retailer_id,store_id,source,source_provider,price,observed_at,created_at) "
                         "VALUES($1,$2,$3,$4,$5,$6,now() - make_interval(days => $7),now())", product, retailer, shop, source,
                         "open_prices" if source == "third_party" else None, 1.5 + number, number)
    await db.execute("INSERT INTO v2_recipes(author_id,title,description,base_servings,steps,created_at) VALUES($1,'T','d',2,'[]'::jsonb,$2)", users[0], now)
    await db.execute("INSERT INTO v2_page_stats VALUES($1,'basket',10,4),($1,'home',5,2),($2,'home',100,50)", stats.bucket_of(now), stats.bucket_of(old))
    async with served as client:
        day = (await client.get("/api/v2/stats", params={"period": "24h"})).json()
        assert day["traffic"]["accounts_created"] == 2
        assert day["traffic"]["pages"] == [{"page": "basket", "views": 10, "visits": 4}, {"page": "home", "views": 5, "visits": 2}]
        assert (day["traffic"]["page_views"], day["traffic"]["visits"]) == (15, 6)
        counts = day["contributions"]
        assert counts["product_proposals"] == 2 and counts["product_proposals_approved"] == 1
        assert (counts["prices_manual"], counts["prices_bookmarklet"], counts["prices_connector"], counts["prices_open_prices"]) == (2, 1, 0, 1)
        assert counts["recipes_created"] == 1 and counts["reports"] == 0 and counts["merges"] == 0
        month = (await client.get("/api/v2/stats", params={"period": "30d"})).json()
        assert month["traffic"]["accounts_created"] == 2 and month["traffic"]["page_views"] == 15, "45 days ago is outside 30 days"
        raw = json.dumps(day)
        assert "ana" not in raw and "ben" not in raw, "no account name anywhere"


@pytest.mark.asyncio
async def test_the_page_beacon_counts_known_pages_and_ignores_floods(monkeypatch):
    write = {"origin": "https://test"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test") as client:
        assert (await client.post("/api/v2/stats/page", headers=write, json={"page": "basket", "visit": True})).status_code == 204
        assert (await client.post("/api/v2/stats/page", headers=write, json={"page": "home"})).status_code == 204
        for body in ({"page": "Jean Dupont"}, {"page": "/v2/produits/3"}, {"page": ""}, {}, {"page": "home", "visit": "x"}):
            assert (await client.post("/api/v2/stats/page", headers=write, json=body)).status_code == 422, body
        assert (await client.post("/api/v2/stats/page", headers={"origin": "https://elsewhere.test"}, json={"page": "home"})).status_code == 403
        assert sorted((page, values) for (_b, page), values in stats._pages.items()) == [("basket", [1, 1]), ("home", [1, 0])]
        monkeypatch.setattr(stats, "allow_beacon", lambda *_a, **_k: False)
        assert (await client.post("/api/v2/stats/page", headers=write, json={"page": "home"})).status_code == 204
        assert stats._pages[next(key for key in stats._pages if key[1] == "home")][0] == 1, "a flood is acknowledged, not counted"


@pytest.mark.asyncio
@needs_db
async def test_the_statistics_are_for_administrators_only(db, served, monkeypatch):
    async def forbidden(_request):
        raise HTTPException(status_code=403)
    monkeypatch.setattr(stats_api, "_require_admin", forbidden)
    async with served as client:
        assert (await client.get("/api/v2/stats")).status_code == 403
