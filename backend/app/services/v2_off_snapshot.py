"""V2-only full Open Food Facts snapshot fetcher."""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from app.services.off_rate_limit import OffRateLimited
from app.services.openfoodfacts_client import off_json_get

OFF_PRODUCT_PAGE = "https://world.openfoodfacts.org/product"
_OFF_PRODUCT_URL = "https://world.openfoodfacts.org/api/v2/product"
logger = logging.getLogger(__name__)


class OffUnavailable(RuntimeError):
    pass


async def fetch_full_off_product(barcode: str) -> dict[str, Any] | None:
    try:
        data = await off_json_get(
            f"{_OFF_PRODUCT_URL}/{barcode}.json", max_bytes=16 * 1024 * 1024
        )
    except OffRateLimited:
        raise
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            return None
        logger.warning("OFF full fetch failed: HTTP %s", exc.response.status_code)
        raise OffUnavailable(str(exc)) from exc
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("OFF full fetch failed: %s", type(exc).__name__)
        raise OffUnavailable(str(exc)) from exc
    product = data.get("product") if data.get("status") == 1 else None
    return product if isinstance(product, dict) else None


async def save_off_snapshot(connection, product_id: int, barcode: str, payload: dict):
    """Persist a fetched full sheet, shared by interactive and queued refreshes."""
    return await connection.fetchrow(
        """
        INSERT INTO v2_product_off_snapshots
            (product_id, barcode, payload, fetched_at, off_rev, off_last_modified_t)
        VALUES($1, $2, $3::jsonb, now(), $4, $5)
        ON CONFLICT(product_id) DO UPDATE SET
            barcode=excluded.barcode,
            payload=excluded.payload,
            fetched_at=excluded.fetched_at,
            off_rev=excluded.off_rev,
            off_last_modified_t=excluded.off_last_modified_t
        RETURNING *
        """,
        product_id, barcode, json.dumps(payload),
        _as_int(payload.get("rev")), _as_int(payload.get("last_modified_t")),
    )


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
