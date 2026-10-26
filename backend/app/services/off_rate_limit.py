"""Enforce Open Food Facts request limits at the HTTP transport layer.

Product reads and searches use separate sliding-window budgets. A request waits
briefly for capacity, then raises OffRateLimited with a Retry-After value when
one can be determined.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections import deque
from collections.abc import Callable

import asyncpg
import httpx
from fastapi import HTTPException

logger = logging.getLogger(__name__)

# OFF's published limits. Deliberately module constants and NOT settings: an
# environment variable that raises these would be a footgun whose only possible
# use is exceeding somebody else's stated limit. Changing them should require
# changing code, and OFF changing its policy is a code change.
PRODUCT_LIMIT_PER_MIN = 15
SEARCH_LIMIT_PER_MIN = 10
WINDOW_SECONDS = 60.0

# How long admission may block before giving up, per bucket. See module
# docstring -- the asymmetry tracks who is waiting and why.
SEARCH_MAX_WAIT_SECONDS = 3.0
PRODUCT_MAX_WAIT_SECONDS = 10.0


class OffRateLimited(httpx.HTTPError):
    """Too many requests -- ours by our own count, or OFF's by its answer.

    ``retry_after`` is the number of seconds after which the request would be
    admitted: computed from the local window when we throttle ourselves, or
    taken from OFF's ``Retry-After`` header when it throttles us. It is what
    lets the API answer "réessayez dans 4 s" instead of a bare failure, so the
    user knows this is a wait rather than a breakage.
    """

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


def retry_after_headers(exc: OffRateLimited) -> dict[str, str]:
    """A ``Retry-After`` header, when the wait is actually known.

    Omitted rather than guessed when it is not: a fabricated number is worse
    than none, because a client that trusts it retries too early and spends
    another slot from the very budget that is already exhausted. Rounded *up*,
    so obeying it can never land back inside the window it was meant to clear.

    Lives here rather than in an endpoint module because both the OFF endpoints
    and product endpoints answer 429 from the same exception.
    """
    if exc.retry_after is None:
        return {}
    return {"Retry-After": str(max(1, math.ceil(exc.retry_after)))}


class SlidingWindowLimiter:
    """At most ``limit`` admissions in any trailing ``window`` seconds."""

    def __init__(
        self,
        limit: int,
        window: float = WINDOW_SECONDS,
        name: str = "",
        clock: Callable[[], float] = time.monotonic,
        smooth: bool = False,
    ) -> None:
        self._limit = limit
        self._window = window
        self._name = name
        self._clock = clock
        # ``smooth`` turns the per-minute cap into an actual pace by also
        # requiring ``window / limit`` between consecutive admissions.
        #
        # Without it the limit is only a burst ceiling: 21 requests fit inside a
        # 60/min budget and go out in 1.3 seconds, which is under the limit and
        # is still not what "gentle to a volunteer-run service" means. Measured,
        # not theorised -- that is exactly what the first real connector run did.
        #
        # Off by default, and deliberately NOT enabled for the interactive
        # buckets. The type-ahead's budget is 10/min; smoothing it would put six
        # seconds between searches and make the field feel broken, and its burst
        # is already bounded by how fast a person types. Batch traffic has no
        # such natural brake, which is the whole difference.
        self._min_interval = (window / limit) if smooth and limit > 0 else 0.0
        self._hits: deque[float] = deque()
        # One lock per bucket, so admission within a bucket is serialised (which
        # is what makes the limit exact under concurrency) while the two buckets
        # stay independent -- a slow product refresh must not queue behind it a
        # search that has budget of its own.
        self._lock = asyncio.Lock()

    def _prune(self, now: float) -> None:
        while self._hits and now - self._hits[0] >= self._window:
            self._hits.popleft()

    async def acquire(self, max_wait: float) -> None:
        """Take one slot, waiting up to ``max_wait`` seconds for one.

        Raises ``OffRateLimited`` rather than waiting longer.
        """
        # The lock is held across the sleep on purpose. Releasing it to wait
        # would let several coroutines each observe "one slot free" and all take
        # it, which is the classic check-then-act race and would put us over the
        # limit precisely when we are busiest.
        async with self._lock:
            deadline = self._clock() + max_wait
            while True:
                now = self._clock()
                self._prune(now)

                # Two independent reasons to wait; take whichever binds. The
                # window says "not more than N per minute", the spacing says
                # "not two at once" -- and a burst satisfies the first while
                # violating the spirit of both.
                wait = 0.0
                if len(self._hits) >= self._limit:
                    wait = self._window - (now - self._hits[0])
                if self._min_interval and self._hits:
                    wait = max(wait, self._min_interval - (now - self._hits[-1]))

                if wait <= 0:
                    self._hits.append(now)
                    return
                if now + wait > deadline:
                    logger.info(
                        "OFF %s budget exhausted (%d/%ds); would need %.1fs, "
                        "ceiling is %.1fs",
                        self._name,
                        self._limit,
                        int(self._window),
                        wait,
                        max_wait,
                    )
                    raise OffRateLimited(
                        f"OpenFoodFacts {self._name} rate limit reached "
                        f"({self._limit} requests per minute)",
                        retry_after=max(wait, 0.0),
                    )
                # Small floor so a near-zero wait cannot spin the loop.
                await asyncio.sleep(max(wait, 0.01))

    def reset(self) -> None:
        """Forget every recorded hit. For tests only."""
        self._hits.clear()


# Self-imposed Open Prices budget; review against its current policy before
# adding a connector that uses this limiter.
OPEN_PRICES_SELF_IMPOSED_PER_MIN = 60
OPEN_PRICES_MAX_WAIT_SECONDS = 30.0

product_limiter = SlidingWindowLimiter(PRODUCT_LIMIT_PER_MIN, name="product")
search_limiter = SlidingWindowLimiter(SEARCH_LIMIT_PER_MIN, name="search")
open_prices_limiter = SlidingWindowLimiter(
    OPEN_PRICES_SELF_IMPOSED_PER_MIN, name="open-prices", smooth=True
)


def reset_limiters() -> None:
    """Clear every bucket. For tests, which must not inherit each other's budget."""
    product_limiter.reset()
    search_limiter.reset()
    open_prices_limiter.reset()


def limiter_for(url: httpx.URL) -> tuple[SlidingWindowLimiter, float]:
    """Pick the bucket and wait ceiling for a URL.

    Unrecognised paths get the *search* bucket -- the stricter of the two. A new
    OFF endpoint whose limit nobody has looked up yet should cost us a slower
    app, not a violated limit, and the failure of this classifier must be
    conservative because nothing downstream re-checks it.
    """
    path = url.path
    if "/search" in path or path.endswith("/cgi/search.pl"):
        return search_limiter, SEARCH_MAX_WAIT_SECONDS
    if "/product" in path:
        return product_limiter, PRODUCT_MAX_WAIT_SECONDS
    return search_limiter, SEARCH_MAX_WAIT_SECONDS


async def acquire_shared_off_slot(url: httpx.URL) -> None:
    """Admit an OFF request using an exact DB-backed sliding window.

    All processes using the same V2 PostgreSQL database share this budget.
    A database failure fails closed: it must never turn into an unmetered call.
    """
    # Imported here so auth/setup initialization does not depend on the OFF client.
    from app.api.v2.auth import _connect

    bucket = "product" if limiter_for(url)[0] is product_limiter else "search"
    limit = PRODUCT_LIMIT_PER_MIN if bucket == "product" else SEARCH_LIMIT_PER_MIN
    max_wait = PRODUCT_MAX_WAIT_SECONDS if bucket == "product" else SEARCH_MAX_WAIT_SECONDS
    deadline = time.monotonic() + max_wait
    while True:
        connection = await _connect()
        try:
            async with connection.transaction():
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(795243, $1)",
                    1 if bucket == "product" else 2,
                )
                await connection.execute(
                    "DELETE FROM v2_off_rate_events WHERE bucket=$1 "
                    "AND admitted_at <= clock_timestamp() - interval '60 seconds'",
                    bucket,
                )
                state = await connection.fetchrow(
                    "SELECT count(*) AS used, "
                    "greatest(0, extract(epoch FROM "
                    "(min(admitted_at) + interval '60 seconds' - clock_timestamp()))) "
                    "AS retry_after FROM v2_off_rate_events WHERE bucket=$1",
                    bucket,
                )
                if state["used"] < limit:
                    await connection.execute(
                        "INSERT INTO v2_off_rate_events(bucket, admitted_at) "
                        "VALUES($1, clock_timestamp())", bucket,
                    )
                    return
                retry_after = float(state["retry_after"])
        except (OSError, TimeoutError, asyncpg.PostgresError) as exc:
            logger.error("Shared OFF quota unavailable: %s", type(exc).__name__)
            raise HTTPException(
                status_code=503,
                detail="Contrôle du quota Open Food Facts indisponible.",
            ) from exc
        finally:
            await connection.close()
        if time.monotonic() + retry_after > deadline:
            raise OffRateLimited(
                f"OpenFoodFacts {bucket} shared rate limit reached",
                retry_after=retry_after,
            )
        await asyncio.sleep(max(retry_after, 0.01))


def _parse_retry_after(value: str | None) -> float | None:
    """OFF's ``Retry-After``, when it is the delta-seconds form.

    The HTTP-date form is allowed by the RFC and simply not parsed here: it
    would need clock-skew handling to be worth anything, and the caller already
    behaves sensibly with ``None`` (report "try again shortly" without inventing
    a number).
    """
    if not value:
        return None
    try:
        return max(float(value.strip()), 0.0)
    except ValueError:
        return None


class RateLimitedTransport(httpx.AsyncBaseTransport):
    """Spends the budget for every request the client makes.

    Wrapping the transport rather than the client means this also covers
    redirects and any future non-GET call, and leaves every existing call site
    unchanged.

    With no ``limiter``, the bucket is chosen per request by URL -- the right
    behaviour for the OpenFoodFacts client, which talks to two endpoint families
    with two different published limits. A client that talks to exactly one
    service (the Open Prices connector) passes its own limiter instead, rather
    than having its traffic classified by a function that knows nothing about
    that host and would silently hand it the fallback bucket.
    """

    def __init__(
        self,
        inner: httpx.AsyncBaseTransport,
        limiter: SlidingWindowLimiter | None = None,
        max_wait: float | None = None,
        shared_off: bool = False,
    ) -> None:
        self._inner = inner
        self._limiter = limiter
        self._max_wait = max_wait
        self._shared_off = shared_off

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self._limiter is not None:
            limiter, max_wait = self._limiter, self._max_wait or 0.0
        else:
            limiter, max_wait = limiter_for(request.url)
        if self._shared_off:
            await acquire_shared_off_slot(request.url)
        else:
            await limiter.acquire(max_wait)

        response = await self._inner.handle_async_request(request)

        if response.status_code == 429:
            # Our own accounting said there was budget and OFF disagreed. That
            # is not a contradiction to paper over: the limit is per IP across
            # everything on this host, and it can also be a global limit
            # unrelated to us. Reported distinctly so the user is told to wait
            # rather than that OFF is broken.
            await response.aread()
            retry_after = _parse_retry_after(response.headers.get("Retry-After"))
            logger.warning(
                "OpenFoodFacts returned 429 for %s (Retry-After=%s)",
                request.url,
                response.headers.get("Retry-After"),
            )
            raise OffRateLimited(
                "OpenFoodFacts rejected the request as rate-limited",
                retry_after=retry_after,
            )

        return response

    async def aclose(self) -> None:
        await self._inner.aclose()
