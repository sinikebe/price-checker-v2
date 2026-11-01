"""Where a product is no longer sold, per store, and how long before a connector looks again.

A status concerns one product at one store for one sales channel. It never hides the product,
its other stores or its price history; it only keeps connectors from reading a page that is
known to be gone, until the re-check delay set here has passed.
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from app.api.v2.auth import _connect, _current_user, _secure_write

router = APIRouter(prefix="/api/v2/availability", tags=["v2-availability"])

MAX_BIGINT = 2**63 - 1
RECHECK_BOUNDS = (0, 365)  # days; 0 means a connector never looks again by itself
MAX_STORES = 200  # stores listed for one product


async def _require_admin_user(connection, request: Request) -> None:
    user = await _current_user(connection, request)
    if user is None or user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Accès administrateur requis.")


class AvailabilitySettingsChange(BaseModel):
    recheck_days: int = Field(ge=RECHECK_BOUNDS[0], le=RECHECK_BOUNDS[1])
    expected_revision: int = Field(ge=0)


async def _settings(connection) -> dict:
    row = await connection.fetchrow("SELECT recheck_days,revision FROM v2_availability_settings WHERE singleton")
    return {"recheck_days": row["recheck_days"], "revision": row["revision"],
            "min": RECHECK_BOUNDS[0], "max": RECHECK_BOUNDS[1]}


@router.get("/settings")
async def read_settings(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        await _require_admin_user(connection, request)
        return await _settings(connection)
    finally:
        await connection.close()


@router.put("/settings")
async def change_settings(payload: AvailabilitySettingsChange, request: Request, response: Response):
    _secure_write(request)
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        await _require_admin_user(connection, request)
        updated = await connection.fetchval(
            "UPDATE v2_availability_settings SET recheck_days=$1, revision=revision+1, updated_at=now() "
            "WHERE singleton AND revision=$2 RETURNING revision",
            payload.recheck_days, payload.expected_revision)
        if updated is None:
            raise HTTPException(status_code=409, detail="Réglage modifié entre-temps. Rechargez la page.")
        return await _settings(connection)
    finally:
        await connection.close()


async def _withdrawn(connection, product_id: int) -> dict:
    rows = await connection.fetch(
        """SELECT s.id AS store_id, s.name AS store_name, s.city, r.name AS retailer,
                  w.sales_channel, w.since, w.checked_at,
                  CASE WHEN c.recheck_days > 0
                       THEN w.checked_at + make_interval(days => c.recheck_days) END AS next_check_at
           FROM v2_store_product_status w
           JOIN v2_stores s ON s.id = w.store_id AND s.active
           JOIN v2_retailers r ON r.id = s.retailer_id
           CROSS JOIN v2_availability_settings c
           WHERE w.product_id = $1 AND w.status = 'discontinued'
             AND NOT EXISTS (
                 SELECT 1 FROM v2_price_observations o
                 WHERE o.product_id = w.product_id AND o.store_id = w.store_id
                   AND o.sales_channel = w.sales_channel AND NOT o.superseded
                   AND o.merge_duplicate_of_id IS NULL AND o.observed_at > w.checked_at)
           ORDER BY w.since DESC, s.id, w.sales_channel LIMIT $2""",
        product_id, MAX_STORES + 1)
    return {"stores": [{
        "store_id": row["store_id"], "store_name": row["store_name"], "city": row["city"],
        "retailer": row["retailer"], "sales_channel": row["sales_channel"],
        "since": row["since"].date().isoformat(), "checked": row["checked_at"].date().isoformat(),
        "next_check": row["next_check_at"].date().isoformat() if row["next_check_at"] else None,
    } for row in rows[:MAX_STORES]], "truncated": len(rows) > MAX_STORES}


@router.get("/products/{product_id}")
async def product_availability(product_id: int, response: Response):
    """The stores where a product is known to be withdrawn. Public, like the prices it qualifies."""
    if not 1 <= product_id <= MAX_BIGINT:
        raise HTTPException(status_code=422, detail="Produit invalide.")
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        return await _withdrawn(connection, product_id)
    finally:
        await connection.close()


@router.delete("/products/{product_id}/stores/{store_id}")
async def look_again(
    product_id: int, store_id: int, request: Request, response: Response,
    channel: Literal["in_store", "drive", "delivery"] = Query("drive"),
):
    """Administrators: forget the status so the connector reads the page again at its next turn."""
    _secure_write(request)
    response.headers["Cache-Control"] = "no-store"
    if not 1 <= product_id <= MAX_BIGINT or not 1 <= store_id <= MAX_BIGINT:
        raise HTTPException(status_code=422, detail="Identifiant invalide.")
    connection = await _connect()
    try:
        await _require_admin_user(connection, request)
        await connection.execute("SELECT v2_clear_store_product_status($1,$2,$3)", product_id, store_id, channel)
        return await _withdrawn(connection, product_id)
    finally:
        await connection.close()
