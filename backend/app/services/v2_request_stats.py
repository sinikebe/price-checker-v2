"""Request and page counters: numbers per endpoint and per time window, nothing about who asked.

Requests are counted by route template ("/api/v2/products/{product_id}"), method and status
class, never by URL, address, account or header. Counters live in memory and are added to
five-minute buckets in the database every half minute. Page views come from a beacon that can
only name a page from a fixed list.
"""
from __future__ import annotations

import logging
import time
from datetime import UTC, datetime, timedelta

logger = logging.getLogger(__name__)

BUCKET_SECONDS = 300
FLUSH_SECONDS = 30
RETENTION_DAYS = 30
MAX_PENDING = 10_000
UNMATCHED = "unmatched"
# Routes of the observability screens themselves, and the page beacon, are not counted.
IGNORED_ROUTES = frozenset({"/api/v2/stats", "/api/v2/stats/page", "/api/v2/logs"})
# The pages the app can report. Anything else is refused: a page name is never free text.
PAGES = (
    "home", "products", "product", "product_edit", "category", "stores", "store", "recipes",
    "recipe", "basket", "settings", "capture", "completion", "auth", "versions", "changelog", "legal", "other",
)
PERIODS = {"1h": timedelta(hours=1), "24h": timedelta(hours=24), "7d": timedelta(days=7), "30d": timedelta(days=30)}
GROUPS = (
    ("basket", "/api/v2/basket"), ("prices", "/api/v2/prices"), ("products", "/api/v2/products"),
    ("catalogue", "/api/v2/catalogue"), ("recipes", "/api/v2/recipes"), ("stores", "/api/v2/stores"),
    ("accounts", "/api/v2/auth"), ("accounts", "/api/v2/account"), ("connectors", "/api/v2/connector-stores"),
)

_requests: dict[tuple[datetime, str, str, int], list[int]] = {}
_pages: dict[tuple[datetime, str], list[int]] = {}
_clients: dict[str, tuple[float, int]] = {}


def bucket_of(moment: datetime) -> datetime:
    moment = moment.astimezone(UTC)
    return moment.replace(minute=moment.minute - moment.minute % 5, second=0, microsecond=0)


def group_of(route: str) -> str:
    for name, prefix in GROUPS:
        if route == prefix or route.startswith(prefix + "/"):
            return name
    return "other"


def record_request(route: str, method: str, status: int, duration_ms: int, now: datetime | None = None) -> None:
    if route in IGNORED_ROUTES or method in ("OPTIONS", "HEAD") or not 100 <= status <= 599:
        return
    key = (bucket_of(now or datetime.now(UTC)), route[:200], method[:10], status // 100)
    if key not in _requests and len(_requests) >= MAX_PENDING:
        return  # a database outage must not grow memory without bound
    entry = _requests.setdefault(key, [0, 0, 0])
    entry[0] += 1
    entry[1] += max(0, duration_ms)
    entry[2] = max(entry[2], duration_ms)


def record_page(page: str, visit: bool, now: datetime | None = None) -> bool:
    """Count one page view (and one visit: the first page of a browser tab session)."""
    if page not in PAGES:
        return False
    entry = _pages.setdefault((bucket_of(now or datetime.now(UTC)), page), [0, 0])
    entry[0] += 1
    entry[1] += 1 if visit else 0
    return True


def allow_beacon(client: str, *, per_minute: int = 120, now: float | None = None) -> bool:
    """A page beacon limiter held in memory only: no address is ever stored."""
    moment = now if now is not None else time.monotonic()
    started, count = _clients.get(client, (moment, 0))
    if moment - started >= 60:
        started, count = moment, 0
    if client not in _clients and len(_clients) >= 10_000:
        _clients.clear()
    _clients[client] = (started, count + 1)
    return count < per_minute


class RequestStatsMiddleware:
    """Counts API requests by route template; written as plain ASGI to stay cheap on every request."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/"):
            await self.app(scope, receive, send)
            return
        status = 500
        started = time.perf_counter()

        async def tracking_send(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, tracking_send)
        finally:
            route = getattr(scope.get("route"), "path", None)
            record_request(route if isinstance(route, str) else UNMATCHED, scope.get("method", "GET"), status,
                           round((time.perf_counter() - started) * 1000))


async def flush(connection) -> int:
    """Add the pending counters to the database. They are put back when that fails."""
    global _requests, _pages
    pending_requests, pending_pages = _requests, _pages
    _requests, _pages = {}, {}
    if not pending_requests and not pending_pages:
        return 0
    try:
        async with connection.transaction():
            await connection.executemany(
                "INSERT INTO v2_request_stats AS t(bucket,route,method,status_class,requests,duration_ms_sum,duration_ms_max) "
                "VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(bucket,route,method,status_class) DO UPDATE SET "
                "requests=t.requests+EXCLUDED.requests,duration_ms_sum=t.duration_ms_sum+EXCLUDED.duration_ms_sum,"
                "duration_ms_max=greatest(t.duration_ms_max,EXCLUDED.duration_ms_max)",
                [(bucket, route, method, status, *values) for (bucket, route, method, status), values in pending_requests.items()])
            await connection.executemany(
                "INSERT INTO v2_page_stats AS t(bucket,page,views,visits) VALUES($1,$2,$3,$4) "
                "ON CONFLICT(bucket,page) DO UPDATE SET views=t.views+EXCLUDED.views,visits=t.visits+EXCLUDED.visits",
                [(bucket, page, *values) for (bucket, page), values in pending_pages.items()])
    except Exception:
        for key, values in pending_requests.items():
            entry = _requests.setdefault(key, [0, 0, 0])
            entry[0] += values[0]
            entry[1] += values[1]
            entry[2] = max(entry[2], values[2])
        for key, values in pending_pages.items():
            entry = _pages.setdefault(key, [0, 0])
            entry[0] += values[0]
            entry[1] += values[1]
        raise
    return len(pending_requests) + len(pending_pages)


async def purge(connection) -> dict[str, int]:
    """Drop what is older than the retention, from the counters and the journal."""
    from app.services.v2_logbook import MAX_ROWS, RETENTION_DAYS as LOG_DAYS
    removed = {}
    for table, column in (("v2_request_stats", "bucket"), ("v2_page_stats", "bucket")):
        status = await connection.execute(
            f"DELETE FROM {table} WHERE {column} < now() - make_interval(days => $1)", RETENTION_DAYS)
        removed[table] = int(status.rsplit(" ", 1)[-1])
    status = await connection.execute(
        "DELETE FROM v2_logs WHERE at < now() - make_interval(days => $1)", LOG_DAYS)
    removed["v2_logs"] = int(status.rsplit(" ", 1)[-1])
    status = await connection.execute(
        "DELETE FROM v2_logs WHERE id < (SELECT id FROM v2_logs ORDER BY id DESC OFFSET $1 - 1 LIMIT 1)", MAX_ROWS)
    removed["v2_logs"] += int(status.rsplit(" ", 1)[-1])
    return removed
