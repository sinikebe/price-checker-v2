"""Host samples stay bounded; alerts are per-metric and admin-only."""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from pathlib import Path

import httpx
import pytest
from app.api.v2 import host_health
from app.main_v2 import app
from fastapi import HTTPException

SCRIPT = Path(__file__).resolve().parents[2] / "deployment/v2/host_health.py"
spec = importlib.util.spec_from_file_location("host_health_sampler", SCRIPT)
assert spec and spec.loader
sampler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sampler)


def _resource(pct: float) -> dict:
    return {"pct": pct, "used_bytes": int(pct),
            "available_bytes": int(100 - pct), "total_bytes": 100}


def test_host_samples_prune_history_and_throttle_each_alert():
    start = datetime(2026, 10, 27, 0, tzinfo=UTC)
    state = {}
    for minute in range(27 * 60):
        at = start + timedelta(minutes=minute)
        cpu = {"total": 1000 + 100 * minute, "idle": 500 + 10 * minute}
        state = sampler.updated_state(state, at, cpu, _resource(85), _resource(83))
    assert len(state["hourly"]) == 24
    assert state["hourly"][0]["hour"] == (start + timedelta(hours=3)).isoformat()
    assert state["hourly"][-1]["samples"] == 60
    assert state["hourly"][-1]["cpu_max"] == pytest.approx(90)
    assert all(alert["at"] >= (start + timedelta(hours=2, minutes=59)).isoformat()
               for alert in state["alerts"])
    assert len(state["alerts"]) <= 72
    for metric in sampler.METRICS:
        alerts = [datetime.fromisoformat(item["at"]) for item in state["alerts"]
                  if item["metric"] == metric]
        assert all(later - earlier >= timedelta(hours=1)
                   for earlier, later in pairwise(alerts))
    assert len(json.dumps(state)) < 65536


def test_host_sample_first_cpu_interval_and_threshold():
    start = datetime(2026, 10, 28, tzinfo=UTC)
    first = sampler.updated_state({}, start, {"total": 100, "idle": 40},
                                  _resource(80), _resource(80))
    assert first["current"]["cpu_pct"] is None
    assert first["alerts"] == []
    second = sampler.updated_state(first, start + timedelta(minutes=1),
                                   {"total": 200, "idle": 50},
                                   _resource(81), _resource(79))
    assert second["current"]["cpu_pct"] == 90
    assert {item["metric"] for item in second["alerts"]} == {"cpu", "memory"}


@pytest.mark.skipif(os.geteuid() != 0, reason="Requires a root-owned parent directory")
def test_host_sampler_can_write_with_root_only_parent(tmp_path):
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    os.chown(state, 1000, 1000)
    result = subprocess.run(["/usr/bin/python3", str(SCRIPT), str(state)],
                            capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    target = state / "host-health.json"
    assert target.stat().st_uid == 1000
    assert json.loads(target.read_text())["current"]["memory"]["total_bytes"] > 0


@pytest.mark.asyncio
async def test_host_health_is_admin_only_and_reads_bounded_file(tmp_path, monkeypatch):
    monkeypatch.setenv("PRICE_CHECKER_V2_STATE_DIR", str(tmp_path))

    async def denied(_request):
        raise HTTPException(status_code=403)
    monkeypatch.setattr(host_health, "_require_admin", denied)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                base_url="https://test") as client:
        assert (await client.get("/api/v2/host-health")).status_code == 403

        async def allowed(_request):
            return None
        monkeypatch.setattr(host_health, "_require_admin", allowed)
        missing = await client.get("/api/v2/host-health")
        assert missing.json() == {"available": False, "reason": "not_installed"}
        assert missing.headers["cache-control"] == "no-store"
        now = datetime.now(UTC)
        state = sampler.updated_state({}, now, {"total": 100, "idle": 40},
                                      _resource(85), _resource(81))
        (tmp_path / "host-health.json").write_text(json.dumps(state))
        result = await client.get("/api/v2/host-health")
        assert result.status_code == 200
        assert result.json()["available"] is True
        assert result.json()["hourly"][0]["memory_avg"] == 85
        assert {alert["metric"] for alert in result.json()["alerts"]} == {"memory", "disk"}
        (tmp_path / "host-health.json").write_text("x" * 65537)
        assert (await client.get("/api/v2/host-health")).status_code == 503
