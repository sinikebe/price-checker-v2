"""Background work of the journal: counters flushed to the database, host results turned into events."""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path

from app.services import v2_logbook as logbook
from app.services import v2_request_stats as stats

logger = logging.getLogger(__name__)
_SHA = re.compile(r"[0-9a-f]{7,40}")
MAX_BYTES = 262_144


def _read(path: Path) -> dict | list | None:
    try:
        with path.open("r", encoding="utf-8") as stream:
            raw = stream.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            return None
        return json.loads(raw)
    except (OSError, ValueError):
        return None


def _update_reason(message) -> str:
    text = str(message or "").lower()
    if "ci has not passed" in text:
        return "ci_not_passed"
    if "fast-forward" in text:
        return "not_fast_forward"
    if "interrupted" in text:
        return "interrupted"
    if "returned non-zero" in text or "update.sh" in text:
        return "update_failed"
    return "other"


async def _once(connection, event: str, run_at: str, at: datetime, **fields) -> int:
    """Record a host result only once: the host files are overwritten by each run, so they are polled."""
    if await connection.fetchval("SELECT 1 FROM v2_logs WHERE event=$1 AND data->>'run_at'=$2 LIMIT 1", event, run_at):
        return 0
    return int(await logbook.log_event(connection, event, at=at, run_at=run_at, **fields))


def _moment(value) -> datetime | None:
    try:
        moment = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    return moment if moment.tzinfo else None


async def ingest_host_events(connection, state_dir: Path) -> int:
    """Journal the last update, the last cache cleaning and the host alerts, each once."""
    added = 0
    update = _read(state_dir / "update-last-run.json")
    if isinstance(update, dict) and update.get("result") in ("updated", "current", "failed"):
        at = _moment(update.get("at"))
        if at:
            fields = {"trigger": update.get("trigger") if update.get("trigger") in ("manual", "scheduled") else "scheduled",
                      "result": update["result"]}
            for key, name in (("from", "from_sha"), ("to", "to_sha")):
                if isinstance(update.get(key), str) and _SHA.fullmatch(update[key]):
                    fields[name] = update[key]
            if update["result"] == "failed":
                fields["reason"] = _update_reason(update.get("message"))
            added += await _once(connection, "update.finished", at.isoformat(), at, **fields)
    cache = _read(state_dir / "cache-clean-last-run.json")
    if isinstance(cache, dict) and cache.get("result") in ("done", "failed"):
        at = _moment(cache.get("at"))
        if at:
            fields = {"trigger": cache.get("trigger") if cache.get("trigger") in ("manual", "update") else "manual",
                      "result": cache["result"]}
            if type(cache.get("freed_bytes")) is int and cache["freed_bytes"] >= 0:
                fields["freed_bytes"] = cache["freed_bytes"]
            added += await _once(connection, "cache.cleaned", at.isoformat(), at, **fields)
    health = _read(state_dir / "host-health.json")
    if isinstance(health, dict) and isinstance(health.get("alerts"), list):
        for alert in health["alerts"][-72:]:
            if not isinstance(alert, dict):
                continue
            at = _moment(alert.get("at"))
            pct = alert.get("pct")
            if at and alert.get("metric") in ("cpu", "memory", "disk") and isinstance(pct, (int, float)) and not isinstance(pct, bool):
                added += await _once(connection, "host.alert", at.isoformat(), at,
                                     metric=alert["metric"], pct=max(0, min(100, round(pct))))
    return added


async def run_once(connect, state_dir: Path) -> None:
    connection = await connect()
    try:
        await stats.flush(connection)
        await ingest_host_events(connection, state_dir)
    finally:
        await connection.close()


async def worker(connect, state_dir_of) -> None:
    """Every half minute: flush the counters and read the host's results. Never stops on an error."""
    while True:
        try:
            await run_once(connect, state_dir_of())
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Journal maintenance deferred: %s", exc.__class__.__name__)
        await asyncio.sleep(stats.FLUSH_SECONDS)


async def final_flush(connect) -> None:
    """On shutdown, keep the last counters."""
    try:
        connection = await connect()
        try:
            await stats.flush(connection)
        finally:
            await connection.close()
    except Exception as exc:
        logger.warning("Final counter flush skipped: %s", exc.__class__.__name__)


async def announce_start(connect, version: str) -> None:
    now = datetime.now(UTC)
    try:
        connection = await connect()
        try:
            await logbook.log_event(connection, "system.started", at=now, version=version)
        finally:
            await connection.close()
    except Exception as exc:
        logger.warning("Start event skipped: %s", exc.__class__.__name__)
