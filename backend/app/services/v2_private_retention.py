"""Expire closed private records without deleting published contributions.

An unresolved moderation item remains active until a reviewer decides it. The
six-month clock starts at that decision.
"""

from __future__ import annotations

import asyncpg

BATCH_SIZE = 500


async def _expired_ids(connection: asyncpg.Connection, table: str, condition: str) -> list[int]:
    # Both SQL fragments are fixed here, never supplied by a request.
    rows = await connection.fetch(
        f"SELECT id FROM {table} WHERE {condition} ORDER BY id "
        "LIMIT $1 FOR UPDATE SKIP LOCKED",
        BATCH_SIZE,
    )
    return [row["id"] for row in rows]


async def purge_private_data(connection: asyncpg.Connection) -> dict[str, int]:
    """Remove at most one batch per category; safe to repeat hourly."""
    removed: dict[str, int] = {}
    async with connection.transaction():
        product_ids = await _expired_ids(
            connection, "v2_product_drafts",
            "status IN ('approved','rejected') AND "
            "coalesce(approved_at,rejected_at,updated_at) < now() - interval '6 months'",
        )
        if product_ids:
            await connection.execute(
                "UPDATE v2_product_events SET draft_id=NULL "
                "WHERE draft_id=ANY($1::bigint[])", product_ids,
            )
            await connection.execute(
                "DELETE FROM v2_product_drafts WHERE id=ANY($1::bigint[])", product_ids,
            )
        removed["product_drafts"] = len(product_ids)

        price_ids = await _expired_ids(
            connection, "v2_price_drafts",
            "status IN ('approved','rejected') AND "
            "reviewed_at < now() - interval '6 months'",
        )
        if price_ids:
            await connection.execute(
                "UPDATE v2_price_observations SET price_draft_id=NULL "
                "WHERE price_draft_id=ANY($1::bigint[])", price_ids,
            )
            await connection.execute(
                "UPDATE v2_offers SET price_draft_id=NULL "
                "WHERE price_draft_id=ANY($1::bigint[])", price_ids,
            )
            await connection.execute(
                "DELETE FROM v2_price_drafts WHERE id=ANY($1::bigint[])", price_ids,
            )
        removed["price_drafts"] = len(price_ids)

        recipe_ids = await _expired_ids(
            connection, "v2_recipe_submissions",
            "status IN ('approved','rejected') AND "
            "reviewed_at < now() - interval '6 months'",
        )
        if recipe_ids:
            await connection.execute(
                "DELETE FROM v2_recipe_submissions WHERE id=ANY($1::bigint[])", recipe_ids,
            )
        removed["recipe_submissions"] = len(recipe_ids)

        report_ids = await _expired_ids(
            connection, "v2_content_reports",
            "status IN ('dismissed','withdrawn') AND "
            "reviewed_at < now() - interval '6 months'",
        )
        if report_ids:
            await connection.execute(
                "DELETE FROM v2_content_reports WHERE id=ANY($1::bigint[])", report_ids,
            )
        removed["reports"] = len(report_ids)

        # A withdrawn-content marker must remain, but its free-text reason is
        # no longer needed once the linked report supplies the review record.
        await connection.execute(
            "UPDATE v2_content_withdrawals SET reason='Signalement traité' "
            "WHERE reason <> 'Signalement traité'",
        )
    return removed
