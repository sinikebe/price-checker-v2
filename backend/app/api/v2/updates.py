"""Administrator-owned schedule for guarded server updates.

The API stores intent only. A root-owned systemd timer reads this file and
runs the existing backup/rollback updater after CI has passed.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import tempfile
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.api.v2.setup import _ensure_state_dir, _require_admin

router = APIRouter(prefix="/api/v2/updates", tags=["v2-updates"])
_TIME = re.compile(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]")
_DEFAULT = {"enabled": False, "time": "02:00", "timezone": "Europe/Paris", "revision": 0}


class ScheduleChange(BaseModel):
    enabled: bool
    time: str
    timezone: str
    expected_revision: int = Field(ge=0)


def _read_schedule(directory: Path) -> dict:
    try:
        schedule = json.loads((directory / "update-schedule.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return _DEFAULT.copy()
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=503, detail="Planification illisible.") from exc
    if (
        not isinstance(schedule, dict)
        or type(schedule.get("enabled")) is not bool
        or not isinstance(schedule.get("time"), str)
        or not _TIME.fullmatch(schedule["time"])
        or not isinstance(schedule.get("timezone"), str)
        or type(schedule.get("revision")) is not int
        or schedule["revision"] < 0
    ):
        raise HTTPException(status_code=503, detail="Planification illisible.")
    try:
        ZoneInfo(schedule["timezone"])
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=503, detail="Fuseau horaire illisible.") from exc
    return schedule


def _status(directory: Path, schedule: dict) -> dict:
    try:
        last_run = json.loads((directory / "update-last-run.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        last_run = None
    except (OSError, ValueError):
        last_run = None
    return {**schedule, "scheduler_installed": (directory / "update-scheduler-installed").is_file(),
            "last_run": last_run}


@router.get("/schedule")
async def schedule(request: Request):
    await _require_admin(request)
    directory = _ensure_state_dir()
    return _status(directory, _read_schedule(directory))


@router.put("/schedule")
async def update_schedule(payload: ScheduleChange, request: Request):
    from app.api.v2.auth import _secure_write

    _secure_write(request)
    await _require_admin(request)
    if not _TIME.fullmatch(payload.time):
        raise HTTPException(status_code=422, detail="Heure invalide (HH:MM).")
    try:
        ZoneInfo(payload.timezone)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Fuseau horaire invalide.") from exc
    directory = _ensure_state_dir()
    if payload.enabled and not (directory / "update-scheduler-installed").is_file():
        raise HTTPException(status_code=503, detail="La planification système n’est pas installée.")
    with (directory / "update-schedule.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = _read_schedule(directory)
        if current["revision"] != payload.expected_revision:
            raise HTTPException(status_code=409, detail="La planification a changé. Rechargez-la avant d’enregistrer.")
        saved = {"enabled": payload.enabled, "time": payload.time,
                 "timezone": payload.timezone, "revision": current["revision"] + 1}
        descriptor, name = tempfile.mkstemp(prefix=".update-schedule-", dir=directory)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as target:
                json.dump(saved, target)
                target.flush()
                os.fsync(target.fileno())
            os.replace(name, directory / "update-schedule.json")
        finally:
            Path(name).unlink(missing_ok=True)
    return _status(directory, saved)
