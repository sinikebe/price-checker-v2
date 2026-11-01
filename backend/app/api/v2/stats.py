"""Administrator statistics: numbers per endpoint, per kind of contribution and per page. No personal data.

Requests are counted by route template; contributions and accounts are counted from the
timestamps the application already keeps; page views come from an anonymous beacon.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, field_validator

from app.api.v2.auth import _connect, _secure_write
from app.api.v2.setup import _require_admin
from app.services import v2_request_stats as stats

router = APIRouter(prefix="/api/v2/stats", tags=["v2-stats"])

# Each contribution kind counts rows the application already stores, by their own timestamp.
CONTRIBUTIONS = (
    ("product_proposals", "SELECT count(*) FROM v2_product_drafts WHERE created_at >= $1"),
    ("product_proposals_approved", "SELECT count(*) FROM v2_product_drafts WHERE approved_at >= $1"),
    ("price_proposals", "SELECT count(*) FROM v2_price_drafts WHERE created_at >= $1"),
    ("price_proposals_approved", "SELECT count(*) FROM v2_price_drafts WHERE status = 'approved' AND reviewed_at >= $1"),
    ("prices_manual", "SELECT count(*) FROM v2_price_observations WHERE source = 'manual' AND created_at >= $1"),
    ("prices_bookmarklet", "SELECT count(*) FROM v2_price_observations WHERE source = 'bookmarklet' AND created_at >= $1"),
    ("prices_connector", "SELECT count(*) FROM v2_price_observations WHERE source = 'connector' AND created_at >= $1"),
    ("prices_open_prices", "SELECT count(*) FROM v2_price_observations WHERE source = 'third_party' AND created_at >= $1"),
    ("recipes_created", "SELECT count(*) FROM v2_recipes WHERE created_at >= $1"),
    ("recipe_submissions", "SELECT count(*) FROM v2_recipe_submissions WHERE created_at >= $1"),
    ("reports", "SELECT count(*) FROM v2_content_reports WHERE created_at >= $1"),
    ("merges", "SELECT count(*) FROM v2_content_merges WHERE merged_at >= $1"),
    ("store_aliases", "SELECT count(*) FROM v2_store_aliases WHERE created_at >= $1"),
)


class PageView(BaseModel):
    page: str
    visit: bool = False

    @field_validator("page")
    @classmethod
    def known_page(cls, value: str) -> str:
        if value not in stats.PAGES:
            raise ValueError("Page inconnue.")
        return value


@router.post("/page", status_code=204)
async def page_view(payload: PageView, request: Request):
    """One page view from the app: a page name from a fixed list, and whether it opened a visit."""
    _secure_write(request)
    client = request.client.host if request.client else "unknown"
    if stats.allow_beacon(client):
        stats.record_page(payload.page, payload.visit)
    return Response(status_code=204)


@router.get("")
async def read_stats(request: Request, response: Response, period: Literal["1h", "24h", "7d", "30d"] = Query("24h")):
    await _require_admin(request)
    response.headers["Cache-Control"] = "no-store"
    until = datetime.now(UTC)
    since = stats.bucket_of(until - stats.PERIODS[period])
    hours = max((until - since).total_seconds() / 3600, 1 / 12)
    connection = await _connect()
    try:
        await stats.flush(connection)  # include what is still held in memory
        rows = await connection.fetch(
            "SELECT route, method, sum(requests)::bigint AS requests, "
            "coalesce(sum(requests) FILTER (WHERE status_class = 4), 0)::bigint AS client_errors, "
            "coalesce(sum(requests) FILTER (WHERE status_class = 5), 0)::bigint AS server_errors, "
            "sum(duration_ms_sum)::bigint AS duration_sum, max(duration_ms_max) AS duration_max "
            "FROM v2_request_stats WHERE bucket >= $1 GROUP BY route, method ORDER BY requests DESC, route, method",
            since)
        recording_since = await connection.fetchval("SELECT min(bucket) FROM v2_request_stats")
        pages = await connection.fetch(
            "SELECT page, sum(views)::bigint AS views, sum(visits)::bigint AS visits FROM v2_page_stats "
            "WHERE bucket >= $1 GROUP BY page ORDER BY views DESC, page", since)
        accounts = await connection.fetchval("SELECT count(*) FROM v2_users WHERE created_at >= $1", since)
        contributions = {key: await connection.fetchval(sql, since) for key, sql in CONTRIBUTIONS}
    finally:
        await connection.close()
    groups: dict[str, dict] = {}
    for row in rows:
        group = groups.setdefault(stats.group_of(row["route"]), {"requests": 0, "errors": 0})
        group["requests"] += row["requests"]
        group["errors"] += row["client_errors"] + row["server_errors"]
    endpoints = [{
        "method": row["method"], "route": row["route"], "requests": row["requests"],
        "per_hour": round(row["requests"] / hours, 2), "client_errors": row["client_errors"],
        "server_errors": row["server_errors"],
        "average_ms": round(row["duration_sum"] / row["requests"]), "max_ms": row["duration_max"],
    } for row in rows[:100]]
    return {
        "period": period, "since": since.isoformat(), "until": until.isoformat(), "hours": round(hours, 2),
        "recording_since": recording_since.astimezone(UTC).isoformat() if recording_since else None,
        "requests": {"total": sum(row["requests"] for row in rows),
                     "client_errors": sum(row["client_errors"] for row in rows),
                     "server_errors": sum(row["server_errors"] for row in rows)},
        "groups": groups, "endpoints": endpoints, "contributions": contributions,
        "traffic": {"page_views": sum(row["views"] for row in pages), "visits": sum(row["visits"] for row in pages),
                    "accounts_created": accounts,
                    "pages": [{"page": row["page"], "views": row["views"], "visits": row["visits"]} for row in pages]},
    }
