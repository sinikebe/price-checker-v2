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


_CONNECTOR_LOGGER = re.compile(r"^price_checker_connector_\d+_(?P<id>[a-z][a-z0-9_-]{1,63})_[0-9a-f]{40}$")
_ERROR_CLASS = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,59}")


class ConnectorFailureCapture(logging.Handler):
    """Journals why a connector reading failed, from the connector's own warnings and errors.

    Only closed facts leave the log record: the class name of the exception, an HTTP status, the product
    number and the fact that the connector disabled itself. The text of the message, which a connector
    may fill with anything, is never read into the journal.
    """

    def __init__(self, connect):
        super().__init__(level=logging.WARNING)
        self.connect = connect
        self.tasks: set[asyncio.Task] = set()

    @staticmethod
    def facts(record: logging.LogRecord) -> tuple[str, dict] | None:
        message = record.msg if isinstance(record.msg, str) else ""
        arguments = record.args if isinstance(record.args, tuple) else ()
        if "connector disabled" in message:
            return "connector.disabled", {}
        fields: dict = {}
        error = type(record.exc_info[1]).__name__ if record.exc_info and record.exc_info[1] else None
        if error and _ERROR_CLASS.fullmatch(error):
            fields["error"] = error
        if "HTTP %s" in message and arguments and type(arguments[-1]) is int and 100 <= arguments[-1] <= 599:
            fields["http_status"] = arguments[-1]
        if "product %s" in message and arguments and type(arguments[0]) is int and arguments[0] > 0:
            fields["product_id"] = arguments[0]
        return ("connector.failure", fields) if ("error" in fields or "http_status" in fields) else None

    def emit(self, record: logging.LogRecord) -> None:
        match = _CONNECTOR_LOGGER.match(record.name)
        if match is None:
            return
        try:
            facts = self.facts(record)
            loop = asyncio.get_running_loop()
        except Exception:  # a log call must never raise; without a running loop there is nowhere to write
            return
        if facts is None:
            return
        event, fields = facts
        connector = match.group("id")
        if not logbook.allow_every(f"failure:{connector}:{event}:{sorted(fields.items())}", 10):
            return
        task = loop.create_task(self._store(event, connector, fields))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def _store(self, event: str, connector: str, fields: dict) -> None:
        try:
            connection = await self.connect()
            try:
                await logbook.log_event(connection, event, connector=connector, **fields)
            finally:
                await connection.close()
        except Exception as exc:
            logger.warning("Connector failure not journaled: %s", exc.__class__.__name__)


def install_connector_capture(connect) -> ConnectorFailureCapture:
    handler = ConnectorFailureCapture(connect)
    logging.getLogger().addHandler(handler)
    return handler


def remove_connector_capture(handler: ConnectorFailureCapture) -> None:
    logging.getLogger().removeHandler(handler)
