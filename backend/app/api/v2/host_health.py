"""Administrator-only view of bounded host-side resource samples."""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, Response

from app.api.v2.setup import _require_admin, _state_dir

router = APIRouter(prefix="/api/v2/host-health", tags=["v2-host-health"])


@router.get("")
async def host_health(request: Request, response: Response):
    await _require_admin(request)
    response.headers["Cache-Control"] = "no-store"
    path = _state_dir() / "host-health.json"
    try:
        with path.open("r", encoding="utf-8") as stream:
            raw = stream.read(65537)
        if len(raw) > 65536:
            raise ValueError("Host-health state is too large")
        state = json.loads(raw)
    except FileNotFoundError:
        return {"available": False, "reason": "not_installed"}
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=503, detail="Mesures de l’hôte indisponibles.") from exc
    if state.get("schema") != 1:
        raise HTTPException(status_code=503, detail="Format des mesures non reconnu.")
    try:
        updated = datetime.fromisoformat(state["updated_at"])
        stale = abs(datetime.now(UTC) - updated) > timedelta(minutes=5)
        points = [{"hour": item["hour"], "cpu_avg": round(item["cpu_sum"] / item["cpu_count"], 1)
                   if item["cpu_count"] else None, "cpu_max": round(item["cpu_max"], 1)
                   if item["cpu_max"] is not None else None,
                   "memory_avg": round(item["memory_sum"] / item["samples"], 1),
                   "memory_max": round(item["memory_max"], 1),
                   "disk_pct": round(item["disk_pct"], 1), "samples": item["samples"],
                   "cpu_samples": item["cpu_count"]} for item in state["hourly"]]
        return {"available": True, "stale": stale, "updated_at": state["updated_at"],
                "current": state["current"], "hourly": points,
                "alerts": state["alerts"]}
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        raise HTTPException(status_code=503, detail="Mesures de l’hôte illisibles.") from exc
