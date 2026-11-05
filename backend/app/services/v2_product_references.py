"""Barcode-only products: created on demand for an Open Food Facts product we do not have.

Such a product holds its barcode and nothing else; the browser reads the rest from Open Food Facts.
Prices, baskets and proposals can point to it. One that has nothing on our side and has not been used
for the configured number of days is deleted by the hourly cleanup.
"""

from __future__ import annotations

import asyncpg

PURGE_BATCH = 200
USE_REFRESH = "1 hour"  # a use is recorded at most once an hour per product

# Nothing on our side points to the product: no price or price proposal, no product proposal or
# history, no recipe or recipe proposal, no shared or demo basket line, no report, merge, withdrawal,
# newer version, offer or availability status.
NOTHING_ON_OUR_SIDE = """
    NOT EXISTS (SELECT 1 FROM v2_price_observations o WHERE o.product_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM v2_price_drafts d WHERE d.product_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM v2_product_drafts d WHERE d.product_id=p.id OR d.result_product_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM v2_product_events e WHERE e.product_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM v2_recipe_ingredients i WHERE i.product_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM v2_recipe_submissions s
                    WHERE s.payload->'ingredients' @> jsonb_build_array(jsonb_build_object('product_id', p.id)))
    AND NOT EXISTS (SELECT 1 FROM v2_shared_basket_lines l WHERE l.product_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM v2_demo_basket b
                    WHERE b.content->'items' @> jsonb_build_array(jsonb_build_object('id', p.id)))
    AND NOT EXISTS (SELECT 1 FROM v2_content_reports r WHERE r.kind='product' AND r.content_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM v2_content_merges m WHERE m.kind='product' AND (m.from_id=p.id OR m.to_id=p.id))
    AND NOT EXISTS (SELECT 1 FROM v2_content_withdrawals w WHERE w.kind='product' AND w.content_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM v2_products n WHERE n.predecessor_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM v2_offer_product_links k WHERE k.product_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM v2_store_product_status t WHERE t.product_id=p.id)
"""


async def touch(connection: asyncpg.Connection, product_ids: list[int]) -> None:
    """Record that these products were used, for those that are barcode-only."""
    if not product_ids:
        return
    await connection.execute(
        "INSERT INTO v2_product_reference_uses(product_id) "
        "SELECT id FROM v2_products WHERE id=ANY($1::bigint[]) AND off_reference "
        "ON CONFLICT (product_id) DO UPDATE SET last_used_at=now() "
        f"WHERE v2_product_reference_uses.last_used_at < now() - interval '{USE_REFRESH}'",
        product_ids)


async def unused_days(connection: asyncpg.Connection) -> int:
    return await connection.fetchval("SELECT unused_days FROM v2_product_reference_settings WHERE singleton")


async def purge_unused(connection: asyncpg.Connection) -> int:
    """Delete at most one batch of unused barcode-only products with nothing on our side."""
    days = await unused_days(connection)
    if not days:
        return 0
    ids = await connection.fetch(
        "SELECT p.id FROM v2_products p LEFT JOIN v2_product_reference_uses u ON u.product_id=p.id "
        "WHERE p.off_reference AND coalesce(u.last_used_at, p.created_at) < now() - make_interval(days => $1) "
        f"AND {NOTHING_ON_OUR_SIDE} ORDER BY p.id LIMIT $2", days, PURGE_BATCH)
    removed = 0
    for row in ids:
        try:
            async with connection.transaction():
                # Our own bookkeeping for the product goes with it; anything else keeps it.
                await connection.execute("DELETE FROM v2_open_prices_sync_state WHERE product_id=$1", row["id"])
                status = await connection.execute(
                    f"DELETE FROM v2_products p WHERE p.id=$1 AND p.off_reference AND {NOTHING_ON_OUR_SIDE}", row["id"])
            removed += status.endswith(" 1")
        except asyncpg.ForeignKeyViolationError:
            continue  # still referenced from somewhere else (a connector's queue, for example): kept
    return removed
