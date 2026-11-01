"""Administrator view of the operational journal (see app/services/v2_logbook.py)."""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Query, Request, Response

from app.api.v2.auth import _connect
from app.api.v2.setup import _require_admin
from app.services.v2_logbook import CONNECTOR_ID, LEVELS, SOURCES
from app.services.v2_request_stats import PERIODS

router = APIRouter(prefix="/api/v2/logs", tags=["v2-logs"])
_NAMES = {number: name for name, number in LEVELS.items()}
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def _cursor(row) -> str:
    """The position after a row, in time order: microseconds since the epoch, a dot and the id."""
    return f"{(row['at'] - _EPOCH) // timedelta(microseconds=1)}.{row['id']}"


def _item(row) -> dict:
    return {"id": row["id"], "at": row["at"].astimezone(UTC).isoformat(), "level": _NAMES[row["level"]],
            "source": row["source"], "event": row["event"], "connector": row["connector"],
            "data": json.loads(row["data"]) if isinstance(row["data"], str) else row["data"]}


@router.get("")
async def read_logs(
    request: Request, response: Response,
    level: Literal["debug", "info", "warning", "error"] = "info",
    source: list[Literal["system", "connector", "basket"]] = Query(default=[]),
    connector: str | None = Query(None, pattern=f"^{CONNECTOR_ID}$"),
    period: Literal["1h", "24h", "7d", "30d"] = "24h",
    before: str | None = Query(None, pattern=r"^\d{1,18}\.\d{1,18}$"),
    limit: int = Query(100, ge=1, le=200),
):
    """Events at or above a level, newest first. `before` is the `next_before` of the previous page."""
    await _require_admin(request)
    response.headers["Cache-Control"] = "no-store"
    since = datetime.now(UTC) - PERIODS[period]
    sources = sorted(set(source)) or list(SOURCES)
    connection = await _connect()
    try:
        scope = "at >= $1 AND source = ANY($2::text[]) AND ($3::text IS NULL OR connector = $3)"
        base = (since, sources, connector)
        if before:
            microseconds, _, identifier = before.partition(".")
            position = (_EPOCH + timedelta(microseconds=int(microseconds)), int(identifier))
        else:
            position = (None, None)
        rows = await connection.fetch(
            f"SELECT id,at,level,source,event,connector,data FROM v2_logs WHERE {scope} AND level >= $4 "
            "AND ($5::timestamptz IS NULL OR (at, id) < ($5, $6::bigint)) ORDER BY at DESC, id DESC LIMIT $7",
            *base, LEVELS[level], *position, limit + 1)
        counts = await connection.fetch(f"SELECT level, count(*) AS n FROM v2_logs WHERE {scope} GROUP BY level", *base)
        connectors = await connection.fetch(
            "SELECT DISTINCT connector FROM v2_logs WHERE connector IS NOT NULL ORDER BY connector LIMIT 100")
    finally:
        await connection.close()
    page = rows[:limit]
    return {
        "items": [_item(row) for row in page],
        "next_before": _cursor(page[-1]) if len(rows) > limit else None,
        "counts": {_NAMES[row["level"]]: row["n"] for row in counts},
        "connectors": [row["connector"] for row in connectors],
    }
