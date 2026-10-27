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
