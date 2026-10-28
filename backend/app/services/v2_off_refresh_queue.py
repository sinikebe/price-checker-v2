"""Retry quota-limited OFF sheet refreshes without weakening the global quota."""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import HTTPException

from app.api.v2.auth import _connect
from app.api.v2.setup import _read_config
from app.services.off_rate_limit import OffRateLimited
from app.services.v2_off_snapshot import (
    OffUnavailable,
    fetch_full_off_product,
    save_off_snapshot,
)

logger = logging.getLogger(__name__)


async def queue_off_refresh(connection, product_id: int, retry_after: float | None) -> None:
    delay = max(1.0, retry_after or 60.0)
    await connection.execute(
        """
        INSERT INTO v2_off_refresh_queue(product_id,next_attempt_at)
        VALUES($1,now() + ($2 * interval '1 second'))
        ON CONFLICT(product_id) DO UPDATE SET
            requested_at=now(),
            next_attempt_at=greatest(v2_off_refresh_queue.next_attempt_at,
                                     excluded.next_attempt_at)
        """,
        product_id, delay,
    )


async def run_due_refresh_once() -> str:
    """Claim one due item; SKIP LOCKED lets multiple workers share a queue."""
    connection = await _connect()
    try:
        async with connection.transaction():
            item = await connection.fetchrow(
                """
                SELECT q.product_id,q.attempts,p.data
                FROM v2_off_refresh_queue q
                JOIN v2_products p ON p.id=q.product_id
                AND NOT EXISTS (SELECT 1 FROM v2_content_withdrawals w
                WHERE w.kind='product' AND w.content_id=p.id)
                AND NOT EXISTS (SELECT 1 FROM v2_content_merges m
                WHERE m.kind='product' AND m.from_id=p.id)
                WHERE q.next_attempt_at <= now()
                ORDER BY q.next_attempt_at,q.requested_at
                LIMIT 1 FOR UPDATE OF q SKIP LOCKED
                """
            )
            if item is None:
                return "empty"
            product_id = item["product_id"]
            data = json.loads(item["data"]) if isinstance(item["data"], str) else item["data"]
            barcode = data.get("ean", "")
            if not barcode or not barcode.isdigit() or len(barcode) not in {8, 12, 13, 14}:
                await connection.execute(
                    "DELETE FROM v2_off_refresh_queue WHERE product_id=$1", product_id
                )
                return "invalid"
            try:
                payload = await fetch_full_off_product(barcode)
            except OffRateLimited as exc:
                await connection.execute(
                    "UPDATE v2_off_refresh_queue SET next_attempt_at="
                    "now()+($2 * interval '1 second'),attempts=attempts+1,"
                    "last_error='quota' WHERE product_id=$1",
                    product_id, max(1.0, exc.retry_after or 60.0),
                )
                return "quota"
            except (OffUnavailable, HTTPException) as exc:
                # Network/remote errors and a temporarily unavailable quota DB
                # keep the item queued; never bypass the shared admission check.
                delay = min(3600, 30 * (2 ** min(item["attempts"], 7)))
                await connection.execute(
                    "UPDATE v2_off_refresh_queue SET next_attempt_at="
                    "now()+($2 * interval '1 second'),attempts=attempts+1,"
                    "last_error=$3 WHERE product_id=$1",
                    product_id, delay, type(exc).__name__[:50],
                )
                logger.warning("Queued OFF refresh failed: %s", type(exc).__name__)
                return "error"
            if payload is not None:
                await save_off_snapshot(connection, product_id, barcode, payload)
            await connection.execute(
                "DELETE FROM v2_off_refresh_queue WHERE product_id=$1", product_id
            )
            return "updated" if payload is not None else "missing"
    finally:
        await connection.close()


async def off_refresh_worker() -> None:
    """Resume pending work after restarts; each process may run one worker."""
    while True:
        if _read_config() is None:
            await asyncio.sleep(30)
            continue
        try:
            result = await run_due_refresh_once()
        except Exception:  # keep the durable queue worker alive on DB errors
            logger.exception("OFF refresh queue unavailable")
            result = "error"
        await asyncio.sleep(5 if result == "updated" else 15 if result == "empty" else 30)
