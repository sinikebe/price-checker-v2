from __future__ import annotations

import asyncio
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
                    follow_redirects=True,
                    headers={"User-Agent": USER_AGENT},
                    # OFF's published per-IP limits are enforced here, in the
                    # transport, so every caller shares the same budget. See
                    # app/services/off_rate_limit.py.
                    # The app's SSL_CERT_FILE points to the private PostgreSQL
                    # certificate. Use public roots explicitly for OFF only.
                    transport=RateLimitedTransport(httpx.AsyncHTTPTransport(
                        verify=ssl.create_default_context(cafile=certifi.where())
                    )),
                )
    return _client


async def aclose_off_client() -> None:
    """Close and clear the shared client, if one exists.

    Called by the application lifespan and available to tests that need a
    clean client state.
    """
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
