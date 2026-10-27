"""Admin schedule state, validation and lost-update protection."""
import json

import httpx
import pytest
from app.api.v2 import updates
from app.main_v2 import app


@pytest.mark.asyncio
async def test_schedule_requires_admin_and_preserves_conflicting_draft(tmp_path, monkeypatch):
    monkeypatch.setenv("PRICE_CHECKER_V2_STATE_DIR", str(tmp_path))
    async def forbidden(_request):
        from fastapi import HTTPException
        raise HTTPException(status_code=403)
    monkeypatch.setattr(updates, "_require_admin", forbidden)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
        assert (await client.get("/api/v2/updates/schedule")).status_code == 403
        assert (await client.put("/api/v2/updates/schedule", json={
            "enabled": True, "time": "02:00", "timezone": "Europe/Paris",
            "expected_revision": 0
        })).status_code == 403

        async def allowed(_request):
            return None
        monkeypatch.setattr(updates, "_require_admin", allowed)
        initial = await client.get("/api/v2/updates/schedule")
        assert initial.json()["enabled"] is False
        assert initial.json()["scheduler_installed"] is False
        payload = {"enabled": True, "time": "02:00", "timezone": "Europe/Paris",
                   "expected_revision": 0}
        assert (await client.put("/api/v2/updates/schedule", json=payload)).status_code == 503
        (tmp_path / "update-scheduler-installed").touch()
        saved = await client.put("/api/v2/updates/schedule", json=payload)
        assert saved.status_code == 200
        assert saved.json()["revision"] == 1
        assert saved.json()["enabled"] is True
        assert json.loads((tmp_path / "update-schedule.json").read_text())["time"] == "02:00"
        assert (await client.put("/api/v2/updates/schedule", json=payload)).status_code == 409
        invalid = {**payload, "expected_revision": 1, "timezone": "Not/AZone"}
        assert (await client.put("/api/v2/updates/schedule", json=invalid)).status_code == 422
        assert (await client.get("/api/v2/updates/schedule")).json()["revision"] == 1


@pytest.mark.asyncio
async def test_manual_update_is_admin_only_and_queued_once(tmp_path, monkeypatch):
    monkeypatch.setenv("PRICE_CHECKER_V2_STATE_DIR", str(tmp_path))

    async def forbidden(_request):
        from fastapi import HTTPException
        raise HTTPException(status_code=403)

    monkeypatch.setattr(updates, "_require_admin", forbidden)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
        assert (await client.post("/api/v2/updates/run")).status_code == 403
        assert not (tmp_path / "update-manual-request.json").exists()

        async def allowed(_request):
            return None

        monkeypatch.setattr(updates, "_require_admin", allowed)
        assert (await client.post("/api/v2/updates/run", headers={"Origin": "https://other"})).status_code == 403
        assert (await client.post("/api/v2/updates/run")).status_code == 503
        (tmp_path / "update-scheduler-installed").touch()
        queued = await client.post("/api/v2/updates/run")
        assert queued.status_code == 202
        assert queued.json()["manual_state"] == "queued"
        assert (await client.post("/api/v2/updates/run")).status_code == 409
        assert (await client.get("/api/v2/updates/schedule")).json()["manual_state"] == "queued"
        (tmp_path / "update-manual-request.json").rename(tmp_path / "update-manual-active.json")
        assert (await client.get("/api/v2/updates/schedule")).json()["manual_state"] == "running"
        assert (await client.post("/api/v2/updates/run")).status_code == 409


def test_manual_runner_uses_ci_gate_and_reports_result(tmp_path, monkeypatch):
    import importlib.util
    from pathlib import Path
    from types import SimpleNamespace

    monkeypatch.setenv("PRICE_CHECKER_V2_DATA_DIR", str(tmp_path))
    path = Path(__file__).resolve().parents[2] / "deployment/v2/scheduled_update.py"
    spec = importlib.util.spec_from_file_location("test_scheduled_update", path)
    assert spec and spec.loader
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    state = tmp_path / "state"
    state.mkdir()
    (state / "update-scheduler-installed").touch()
    (state / "update-manual.lock").touch()
    monkeypatch.setattr(runner, "DATA", tmp_path)
    monkeypatch.setattr(runner, "STATE", state)
    monkeypatch.setattr(runner, "REPO", tmp_path / "source")
    monkeypatch.setattr(runner.os, "geteuid", lambda: 0)
    monkeypatch.setenv("PRICE_CHECKER_V2_ENV", "dev")
    monkeypatch.setenv("PRICE_CHECKER_V2_GIT_BRANCH", "dev")

    old, target = "a" * 40, "b" * 40
    def fake_git(*args):
        if args == ("rev-parse", "HEAD"):
            return old
        if args == ("rev-parse", "FETCH_HEAD"):
            return target
        if args == ("show", "-s", "--format=%s", target):
            return "feature"
        return ""

    monkeypatch.setattr(runner, "git", fake_git)
    calls = []
    def fake_run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(runner.subprocess, "run", fake_run)
    monkeypatch.setattr(runner, "ci_succeeded", lambda *_: False)
    request = state / "update-manual-request.json"
    assert runner.main() == 0  # A disabled schedule does not run without a request.
    assert not calls
    request.write_text('{"id": "test"}')
    assert runner.main() == 1
    failed = json.loads((state / "update-last-run.json").read_text())
    assert failed["result"] == "failed"
    assert failed["trigger"] == "manual"
    assert not request.exists()
    assert not (state / "update-manual-active.json").exists()
    assert len(calls) == 1  # Git ancestry only; no updater without green CI.

    monkeypatch.setattr(runner, "ci_succeeded", lambda *_: True)
    request.write_text('{"id": "test2"}')
    assert runner.main() == 0
    finished = json.loads((state / "update-last-run.json").read_text())
    assert finished["result"] == "updated"
    assert finished["trigger"] == "manual"
    assert len(calls) == 3
    assert calls[-1][1]["env"]["PRICE_CHECKER_V2_EXPECTED_SHA"] == target
    assert not request.exists()
    assert not (state / "update-manual-active.json").exists()
    # An interrupted run must be reported, never retried implicitly.
    active = state / "update-manual-active.json"
    active.write_text('{"id": "interrupted"}')
    assert runner.main() == 1
    assert json.loads((state / "update-last-run.json").read_text())["result"] == "failed"
    assert not active.exists()
    assert len(calls) == 3
