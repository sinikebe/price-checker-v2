"""V2-only full Open Food Facts snapshot fetcher."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.services.off_rate_limit import OffRateLimited
from app.services.openfoodfacts_client import get_off_client

OFF_PRODUCT_PAGE = "https://world.openfoodfacts.org/product"
_OFF_PRODUCT_URL = "https://world.openfoodfacts.org/api/v2/product"
logger = logging.getLogger(__name__)


class OffUnavailable(RuntimeError):
    pass


async def fetch_full_off_product(barcode: str) -> dict[str, Any] | None:
    try:
        response = await (await get_off_client()).get(
            f"{_OFF_PRODUCT_URL}/{barcode}.json"
        )
        response.raise_for_status()
        data = response.json()
    except OffRateLimited:
        raise
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("OFF full fetch failed: %s", type(exc).__name__)
        raise OffUnavailable(str(exc)) from exc
    product = data.get("product") if data.get("status") == 1 else None
    return product if isinstance(product, dict) else None


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None
