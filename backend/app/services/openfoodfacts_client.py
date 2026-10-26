from __future__ import annotations

import asyncio
import json
import re
import ssl

import certifi
import httpx

from app.core.config import get_settings
from app.services.off_rate_limit import RateLimitedTransport

OFF_SEARCH_URL = "https://search.openfoodfacts.org/search"
# OpenFoodFacts policy requires a descriptive User-Agent identifying the app.
USER_AGENT = "PriceChecker/0.1 (+https://github.com/sinikebe/price-checker-v2)"

# A single process-wide client is reused across requests so we don't pay for a
# fresh TCP + TLS handshake to OpenFoodFacts on every search. It is created
# lazily (on first use) rather than in an app startup hook, and guarded by a
# lock so concurrent requests during a cold start can't race and create more
# than one client.
_client: httpx.AsyncClient | None = None
_client_lock = asyncio.Lock()


async def get_off_client() -> httpx.AsyncClient:
    """Return the shared OpenFoodFacts HTTP client, creating it on first use.

    The application lifespan calls ``aclose_off_client`` on shutdown.
    """
    global _client
    if _client is None:
        async with _client_lock:
            if _client is None:
                settings = get_settings()
                _client = httpx.AsyncClient(
                    timeout=settings.REQUEST_TIMEOUT_SECONDS,
                    follow_redirects=False,
                    headers={"User-Agent": USER_AGENT},
                    # OFF's published per-IP limits are enforced here, in the
                    # transport, so every caller shares the same budget. See
                    # app/services/off_rate_limit.py.
                    # The app's SSL_CERT_FILE points to the private PostgreSQL
                    # certificate. Use public roots explicitly for OFF only.
                    transport=RateLimitedTransport(httpx.AsyncHTTPTransport(
                        verify=ssl.create_default_context(cafile=certifi.where()),
                        limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
                    ), shared_off=True),
                )
    return _client


_OFF_PRODUCT_PATH = re.compile(r"/api/v2/product/[0-9]{8,14}\.json")
_off_concurrency = asyncio.Semaphore(8)


class OffResponseError(ValueError):
    """OFF sent an unexpected redirect, oversized body or invalid JSON."""


async def off_json_get(url: str, *, params: dict | None = None, max_bytes: int) -> dict:
    """Read only bounded JSON from the two exact OFF API destinations."""
    target = httpx.URL(url)
    if (
        target.scheme != "https"
        or target.port not in (None, 443)
        or target.username
        or target.password
        or not (
            str(target) == OFF_SEARCH_URL
            or (
                target.host == "world.openfoodfacts.org"
                and _OFF_PRODUCT_PATH.fullmatch(target.path)
            )
        )
    ):
        raise OffResponseError("OFF destination is not allowed")
    client = await get_off_client()
    chunks = []
    size = 0
    try:
        async with (
            _off_concurrency,
            asyncio.timeout(20),
            client.stream("GET", target, params=params, follow_redirects=False) as response,
        ):
            if response.is_redirect:
                raise OffResponseError("OFF redirected the API request")
            response.raise_for_status()
            length = response.headers.get("content-length")
            if length is not None and int(length) > max_bytes:
                raise OffResponseError("OFF response is too large")
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > max_bytes:
                    raise OffResponseError("OFF response is too large")
                chunks.append(chunk)
    except TimeoutError as exc:
        raise OffResponseError("OFF response timed out") from exc
    data = json.loads(b"".join(chunks))
    if not isinstance(data, dict):
        raise OffResponseError("OFF response is not an object")
    return data


async def aclose_off_client() -> None:
    """Close and clear the shared client, if one exists.

    Called by the application lifespan and available to tests that need a
    clean client state.
    """
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
