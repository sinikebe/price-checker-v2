"""Dynamic catalogue search: the complete list for few matches, the rate limit and the admin setting."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio

from app.api.v2 import catalogue
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)
PARITY = json.loads((Path(__file__).parents[2] / "frontend/tests/fixtures/search-parity.json").read_text())


@pytest_asyncio.fixture
async def config():
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_search_" + secrets.token_hex(5)
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


@pytest.fixture
def served(monkeypatch, config):
    """The catalogue routes on the disposable database, with a role chosen per request."""
    async def connect():
        return await connect_v2(config)

    async def user(_connection, request):
        role = request.headers.get("x-test-role")
        return {"id": 1, "role": role} if role else None
    monkeypatch.setattr(catalogue, "_connect", connect)
    monkeypatch.setattr(catalogue, "_current_user", user)
    monkeypatch.setattr(catalogue, "SUGGEST_PER_MINUTE", 10_000)
    monkeypatch.setattr(catalogue, "SUGGEST_PER_HOUR", 100_000)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test")


async def add_products(config, rows):
    connection = await connect_v2(config)
    try:
        return [await connection.fetchval(
            "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id", json.dumps(data)) for data in rows]
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_the_server_matches_what_the_browser_matches(served, config):
    """The browser filters locally with the same rule: both must give the shared fixture's answers."""
    ids = await add_products(config, [product["data"] for product in PARITY["products"]])
    by_fixture = dict(zip((product["id"] for product in PARITY["products"]), ids, strict=True))
    async with served as client:
        for case in PARITY["queries"]:
            expected = sorted(by_fixture[number] for number in case["ids"])
            suggest = await client.get("/api/v2/catalogue/suggest", params={"q": case["q"]})
            assert suggest.status_code == 200, (case, suggest.text)
            body = suggest.json()
            assert body["complete"] is True and body["total"] == len(expected), case
            assert sorted(item["id"] for item in body["items"]) == expected, case
            legacy = await client.get("/api/v2/catalogue/search", params={"q": case["q"], "limit": 50})
            assert sorted(item["id"] for item in legacy.json()["items"]) == expected, case


@pytest.mark.asyncio
async def test_the_list_is_sent_only_when_it_is_short_enough(served, config):
    await add_products(config, [{"brand": "Test", "name": f"Lait {number}", "quantity": "1 L"} for number in range(8)])
    connection = await connect_v2(config)
    try:
        await connection.execute("UPDATE v2_search_settings SET complete_list_max=8")
        async with served as client:
            exactly = (await client.get("/api/v2/catalogue/suggest", params={"q": "lait"})).json()
            assert (exactly["total"], exactly["complete"], exactly["max"], len(exactly["items"])) == (8, True, 8, 8)
            await connection.execute("UPDATE v2_search_settings SET complete_list_max=7")
            many = (await client.get("/api/v2/catalogue/suggest", params={"q": "lait"})).json()
            assert (many["total"], many["complete"], many["max"], many["items"]) == (8, False, 7, [])
            none = (await client.get("/api/v2/catalogue/suggest", params={"q": "inexistant"})).json()
            assert (none["total"], none["complete"], none["items"]) == (0, True, [])
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_a_complete_list_is_sorted_like_the_paginated_search(served, config):
    await add_products(config, [{"brand": "Zeta", "name": "Lait"}, {"brand": "Alpha", "name": "Lait"}, {"brand": "alpha", "name": "Beurre lait"}])
    async with served as client:
        suggest = (await client.get("/api/v2/catalogue/suggest", params={"q": "lait"})).json()["items"]
        legacy = (await client.get("/api/v2/catalogue/search", params={"q": "lait"})).json()["items"]
        assert [item["id"] for item in suggest] == [item["id"] for item in legacy]


@pytest.mark.asyncio
async def test_the_catalogue_group_filter_applies(served, config):
    await add_products(config, [{"name": "Lait entier", "group": "Lait"}, {"name": "Lait de coco", "group": "Cuisine du monde"}])
    async with served as client:
        everything = (await client.get("/api/v2/catalogue/suggest", params={"q": "lait"})).json()
        assert everything["total"] == 2
        one = (await client.get("/api/v2/catalogue/suggest", params={"q": "lait", "category": "cuisine du monde"})).json()
        assert [item["data"]["name"] for item in one["items"]] == ["Lait de coco"]


@pytest.mark.asyncio
async def test_too_short_or_invalid_requests_are_refused_before_they_are_counted(served, config):
    async with served as client:
        for params in ({"q": "a"}, {"q": "  a  "}, {"q": ""}, {"q": "x" * 121},
                       {"q": "lait", "store_id": 0}, {"q": "lait", "store_id": 2**63}):
            assert (await client.get("/api/v2/catalogue/suggest", params=params)).status_code == 422, params
        assert (await client.get("/api/v2/catalogue/search", params={"q": "lait", "store_id": 2**63})).status_code == 422
        assert (await client.get("/api/v2/catalogue/suggest", params={"q": "ab"})).status_code == 200
    connection = await connect_v2(config)
    try:
        assert await connection.fetchval("SELECT count(*) FROM v2_auth_limits") == 2  # only the valid request: minute + hour
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_the_minute_budget_limits_a_client(served, config, monkeypatch):
    monkeypatch.setattr(catalogue, "SUGGEST_PER_MINUTE", 3)
    async with served as client:
        for _ in range(3):
            assert (await client.get("/api/v2/catalogue/suggest", params={"q": "lait"})).status_code == 200
        refused = await client.get("/api/v2/catalogue/suggest", params={"q": "lait"})
        assert refused.status_code == 429
        assert 1 <= int(refused.headers["retry-after"]) <= 60
        assert "Trop de recherches" in refused.json()["detail"]
        # The paginated search used for filter-only browsing is not part of this budget.
        assert (await client.get("/api/v2/catalogue/search", params={"q": "lait"})).status_code == 200


@pytest.mark.asyncio
async def test_a_refusal_by_the_minute_budget_does_not_spend_the_hour_budget(served, config, monkeypatch):
    monkeypatch.setattr(catalogue, "SUGGEST_PER_MINUTE", 2)
    monkeypatch.setattr(catalogue, "SUGGEST_PER_HOUR", 3)
    client_key = catalogue._limit_key("catalogue-suggest-minute", SimpleNamespace(client=SimpleNamespace(host="127.0.0.1")))
    async with served as client:
        for _ in range(2):
            assert (await client.get("/api/v2/catalogue/suggest", params={"q": "lait"})).status_code == 200
        assert (await client.get("/api/v2/catalogue/suggest", params={"q": "lait"})).status_code == 429
        connection = await connect_v2(config)
        try:
            await connection.execute("DELETE FROM v2_auth_limits WHERE key=$1", client_key)  # a minute later
        finally:
            await connection.close()
        # The hour budget (3) was charged for two admitted requests only, so one more is allowed...
        assert (await client.get("/api/v2/catalogue/suggest", params={"q": "lait"})).status_code == 200
        # ...and then the hour budget refuses, with a wait longer than a minute.
        refused = await client.get("/api/v2/catalogue/suggest", params={"q": "lait"})
        assert refused.status_code == 429
        assert int(refused.headers["retry-after"]) > 60


@pytest.mark.asyncio
async def test_different_clients_have_their_own_budget(served, config, monkeypatch):
    monkeypatch.setattr(catalogue, "SUGGEST_PER_MINUTE", 1)
    first = httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("10.0.0.1", 1)), base_url="https://test")
    second = httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("10.0.0.2", 1)), base_url="https://test")
    async with first, second:
        assert (await first.get("/api/v2/catalogue/suggest", params={"q": "lait"})).status_code == 200
        assert (await first.get("/api/v2/catalogue/suggest", params={"q": "lait"})).status_code == 429
        assert (await second.get("/api/v2/catalogue/suggest", params={"q": "lait"})).status_code == 200


@pytest.mark.asyncio
async def test_only_an_administrator_reads_and_changes_the_setting(served, config):
    write = {"origin": "https://test"}
    url = "/api/v2/catalogue/search-settings"
    async with served as client:
        assert (await client.get(url)).status_code == 403
        assert (await client.get(url, headers={"x-test-role": "confirmed"})).status_code == 403
        admin = {"x-test-role": "admin"}
        current = await client.get(url, headers=admin)
        assert current.status_code == 200 and current.headers["cache-control"] == "no-store"
        assert current.json() == {"complete_list_max": 50, "revision": 0, "min": 5, "max": 200,
                                  "per_minute": 10_000, "per_hour": 100_000}
        body = {"complete_list_max": 12, "expected_revision": 0}
        assert (await client.put(url, headers=write, json=body)).status_code == 403
        assert (await client.put(url, headers={**write, "x-test-role": "confirmed"}, json=body)).status_code == 403
        saved = await client.put(url, headers={**write, **admin}, json=body)
        assert saved.status_code == 200, saved.text
        assert (saved.json()["complete_list_max"], saved.json()["revision"]) == (12, 1)
        stale = await client.put(url, headers={**write, **admin}, json=body)
        assert stale.status_code == 409  # revision 0 is no longer current
        for out_of_range in (4, 201, 0, -1):
            refused = await client.put(url, headers={**write, **admin}, json={"complete_list_max": out_of_range, "expected_revision": 1})
            assert refused.status_code == 422, out_of_range
        applied = await client.get("/api/v2/catalogue/suggest", params={"q": "lait"})
        assert applied.json()["max"] == 12
