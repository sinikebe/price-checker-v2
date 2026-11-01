"""Server cache view and cleaning request: admin-only, one request at a time, tolerant of bad host files."""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from app.api.v2 import server_cache
from app.main_v2 import app
from fastapi import HTTPException

URL = "/api/v2/server-cache"
USAGE = {
    "schema": 1, "at": datetime.now(UTC).isoformat(),
    "disk": {"total_bytes": 100, "used_bytes": 60, "available_bytes": 40},
    "images": {"count": 4, "dangling": 2, "size_bytes": 30, "reclaimable_bytes": 20},
    "build_cache": {"size_bytes": 10, "reclaimable_bytes": 10},
    "backups": {"count": 3, "bytes": 5},
}


def ago(**delta) -> str:
    return (datetime.now(UTC) - timedelta(**delta)).isoformat()


@pytest.fixture
def state(tmp_path, monkeypatch):
    monkeypatch.setenv("PRICE_CHECKER_V2_STATE_DIR", str(tmp_path))

    async def allowed(_request):
        return None
    monkeypatch.setattr(server_cache, "_require_admin", allowed)
    return tmp_path


@pytest.fixture
def client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test")


def write(directory, name, value):
    (directory / name).write_text(value if isinstance(value, str) else json.dumps(value))


@pytest.mark.asyncio
async def test_only_an_administrator_reads_or_requests(tmp_path, monkeypatch, client):
    monkeypatch.setenv("PRICE_CHECKER_V2_STATE_DIR", str(tmp_path))
    (tmp_path / "update-scheduler-installed").touch()

    async def forbidden(_request):
        raise HTTPException(status_code=403)
    monkeypatch.setattr(server_cache, "_require_admin", forbidden)
    async with client:
        assert (await client.get(URL)).status_code == 403
        assert (await client.post(URL + "/clean")).status_code == 403
    assert not (tmp_path / "cache-clean-request.json").exists()


@pytest.mark.asyncio
async def test_nothing_is_known_before_the_host_publishes(state, client):
    async with client:
        answer = await client.get(URL)
    assert answer.status_code == 200 and answer.headers["cache-control"] == "no-store"
    assert answer.json() == {"scheduler_installed": False, "state": None, "usage": None, "last_run": None}


@pytest.mark.asyncio
async def test_the_figures_and_the_last_result_are_exposed(state, client):
    write(state, "server-usage.json", USAGE)
    write(state, "cache-clean-last-run.json", {"at": ago(hours=2), "result": "done", "trigger": "update", "freed_bytes": 1234})
    async with client:
        body = (await client.get(URL)).json()
    assert body["usage"]["images"] == {"count": 4, "dangling": 2, "size_bytes": 30, "reclaimable_bytes": 20}
    assert body["usage"]["backups"] == {"count": 3, "bytes": 5} and body["usage"]["stale"] is False
    assert body["last_run"] == {**body["last_run"], "result": "done", "trigger": "update", "freed_bytes": 1234}


@pytest.mark.asyncio
async def test_old_figures_are_flagged_and_unrecognised_ones_are_ignored(state, client):
    write(state, "server-usage.json", {**USAGE, "at": ago(hours=13)})
    async with client:
        assert (await client.get(URL)).json()["usage"]["stale"] is True
        for broken in ({**USAGE, "schema": 2}, {**USAGE, "at": "yesterday"}, {**USAGE, "at": datetime.now().isoformat()},
                       {**USAGE, "disk": {**USAGE["disk"], "used_bytes": -1}},
                       {**USAGE, "images": {**USAGE["images"], "count": "4"}},
                       {key: value for key, value in USAGE.items() if key != "backups"}, "[1]", "{oops"):
            write(state, "server-usage.json", broken)
            assert (await client.get(URL)).json()["usage"] is None, broken
        (state / "server-usage.json").write_text(" " * 70000)
        assert (await client.get(URL)).json()["usage"] is None


@pytest.mark.asyncio
async def test_a_cleaning_is_queued_once_and_only_where_the_host_timer_exists(state, client):
    async with client:
        assert (await client.post(URL + "/clean")).status_code == 503
        (state / "update-scheduler-installed").touch()
        queued = await client.post(URL + "/clean")
        assert queued.status_code == 202 and queued.json()["state"] == "queued"
        request = json.loads((state / "cache-clean-request.json").read_text())
        assert set(request) == {"id", "requested_at"}, "nothing from the client is stored"
        assert (await client.post(URL + "/clean")).status_code == 409
        assert (await client.get(URL)).json()["state"] == "queued"
    assert [item.name for item in state.iterdir() if item.name.startswith(".cache-clean-")] == []


@pytest.mark.asyncio
async def test_a_running_cleaning_blocks_a_new_request_until_it_expires(state, client):
    (state / "update-scheduler-installed").touch()
    write(state, "cache-clean-last-run.json", {"at": ago(minutes=2), "result": "running", "trigger": "manual"})
    async with client:
        assert (await client.get(URL)).json()["state"] == "running"
        assert (await client.post(URL + "/clean")).status_code == 409
        write(state, "cache-clean-last-run.json", {"at": ago(minutes=40), "result": "running", "trigger": "manual"})
        stale = (await client.get(URL)).json()
        assert stale["state"] is None and stale["last_run"]["result"] == "failed", "a run that never reported back"
        assert (await client.post(URL + "/clean")).status_code == 202


@pytest.mark.asyncio
async def test_a_second_cleaning_right_after_the_first_waits(state, client):
    (state / "update-scheduler-installed").touch()
    write(state, "cache-clean-last-run.json", {"at": ago(minutes=1), "result": "done", "trigger": "manual", "freed_bytes": 1})
    async with client:
        assert (await client.post(URL + "/clean")).status_code == 429
        write(state, "cache-clean-last-run.json", {"at": ago(minutes=6), "result": "done", "trigger": "manual", "freed_bytes": 1})
        assert (await client.post(URL + "/clean")).status_code == 202


@pytest.mark.asyncio
async def test_an_unreadable_last_result_is_ignored(state, client):
    async with client:
        for broken in ({"at": ago(hours=1), "result": "weird"}, {"at": "soon", "result": "done"}, "{oops", "[]"):
            write(state, "cache-clean-last-run.json", broken)
            assert (await client.get(URL)).json()["last_run"] is None, broken
        write(state, "cache-clean-last-run.json", {"at": ago(hours=1), "result": "failed", "trigger": "x", "message": "m" * 500, "freed_bytes": -3})
        last = (await client.get(URL)).json()["last_run"]
    assert last["trigger"] == "manual" and len(last["message"]) == 200 and "freed_bytes" not in last
