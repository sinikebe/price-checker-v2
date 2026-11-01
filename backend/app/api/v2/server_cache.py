"""Administrator view of the disk space taken by the server, and a request to clean its cache.

The backend can neither run Docker nor see the host: it only records an
intent. A root-owned timer performs a fixed cleanup (see
deployment/v2/clean_server_cache.py) and publishes the figures and the result.
"""
from __future__ import annotations

import fcntl
import json
import os
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request, Response

from app.api.v2.setup import _ensure_state_dir, _require_admin

router = APIRouter(prefix="/api/v2/server-cache", tags=["v2-server-cache"])

COOLDOWN = timedelta(minutes=5)  # between two cleanings
RUNNING_EXPIRES = timedelta(minutes=30)  # a run that never reported back is not running any more
USAGE_STALE = timedelta(hours=12)
MAX_BYTES = 65536
_RESULTS = {"done", "failed", "running"}
_TRIGGERS = {"manual", "update"}


def _number(value) -> bool:
    return type(value) is int and value >= 0


def _read(path: Path) -> dict | None:
    try:
        with path.open("r", encoding="utf-8") as stream:
            raw = stream.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            return None
        value = json.loads(raw)
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _moment(value) -> datetime | None:
    try:
        moment = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    return moment if moment.tzinfo else None


def _usage(directory: Path) -> dict | None:
    """The figures published by the host, or None when absent or not recognised."""
    raw = _read(directory / "server-usage.json")
    if raw is None or raw.get("schema") != 1:
        return None
    at = _moment(raw.get("at"))
    try:
        disk, images, cache, backups = raw["disk"], raw["images"], raw["build_cache"], raw["backups"]
        numbers = [disk["total_bytes"], disk["used_bytes"], disk["available_bytes"], images["count"],
                   images["dangling"], images["size_bytes"], images["reclaimable_bytes"],
                   cache["size_bytes"], cache["reclaimable_bytes"], backups["count"], backups["bytes"]]
    except (KeyError, TypeError):
        return None
    if at is None or not all(_number(item) for item in numbers):
        return None
    return {"at": at.isoformat(), "stale": datetime.now(UTC) - at > USAGE_STALE,
            "disk": {key: disk[key] for key in ("total_bytes", "used_bytes", "available_bytes")},
            "images": {key: images[key] for key in ("count", "dangling", "size_bytes", "reclaimable_bytes")},
            "build_cache": {key: cache[key] for key in ("size_bytes", "reclaimable_bytes")},
            "backups": {key: backups[key] for key in ("count", "bytes")}}


def _last_run(directory: Path) -> dict | None:
    raw = _read(directory / "cache-clean-last-run.json")
    if raw is None or raw.get("result") not in _RESULTS or _moment(raw.get("at")) is None:
        return None
    run = {"at": raw["at"], "result": raw["result"],
           "trigger": raw["trigger"] if raw.get("trigger") in _TRIGGERS else "manual"}
    if _number(raw.get("freed_bytes")):
        run["freed_bytes"] = raw["freed_bytes"]
    if isinstance(raw.get("message"), str):
        run["message"] = raw["message"][:200]
    return run


def _status(directory: Path) -> dict:
    last = _last_run(directory)
    now = datetime.now(UTC)
    running = bool(last and last["result"] == "running" and now - _moment(last["at"]) < RUNNING_EXPIRES)
    queued = (directory / "cache-clean-request.json").exists()
    if last and last["result"] == "running" and not running:
        last = {**last, "result": "failed", "message": "Le nettoyage n’a pas rendu compte de son résultat."}
    return {"scheduler_installed": (directory / "update-scheduler-installed").is_file(),
            "state": "running" if running else "queued" if queued else None,
            "usage": _usage(directory), "last_run": last}


@router.get("")
async def server_cache(request: Request, response: Response):
    await _require_admin(request)
    response.headers["Cache-Control"] = "no-store"
    return _status(_ensure_state_dir())


@router.post("/clean", status_code=202)
async def request_clean(request: Request, response: Response):
    """Queue one cleaning for the root-owned timer; no command or path comes from the client."""
    from app.api.v2.auth import _secure_write

    _secure_write(request)
    await _require_admin(request)
    response.headers["Cache-Control"] = "no-store"
    directory = _ensure_state_dir()
    if not (directory / "update-scheduler-installed").is_file():
        raise HTTPException(status_code=503, detail="Le programme système n’est pas installé.")
    with (directory / "cache-clean.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        status = _status(directory)
        if status["state"]:
            raise HTTPException(status_code=409, detail="Un nettoyage est déjà demandé.")
        last = status["last_run"]
        if last and last["result"] != "running" and datetime.now(UTC) - _moment(last["at"]) < COOLDOWN:
            raise HTTPException(status_code=429, detail="Un nettoyage vient d’avoir lieu. Réessayez dans quelques minutes.")
        descriptor, name = tempfile.mkstemp(prefix=".cache-clean-", dir=directory)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as target:
                json.dump({"id": uuid4().hex, "requested_at": datetime.now(UTC).isoformat()}, target)
                target.flush()
                os.fsync(target.fileno())
            os.chmod(name, 0o644)
            os.replace(name, directory / "cache-clean-request.json")
        finally:
            Path(name).unlink(missing_ok=True)
    return _status(directory)
