"""SQL fragments and the id bound that the routers share.

Plain strings and numbers only, with no application import, so any module can use them
without an import cycle. The product fragments expect the products table under the alias `p`.
"""

# The largest PostgreSQL bigint: the upper bound of every id a request may name.
MAX_BIGINT = 2**63 - 1

# A catalogue category is the existing comparable group, never a second field.
CATEGORY = "COALESCE(NULLIF(btrim(p.data->>'group'), ''), 'Sans groupe')"
# Live product: not withdrawn, not replaced by a newer version, not merged into another.
LIVE_PRODUCT = """NOT EXISTS (
    SELECT 1 FROM v2_content_withdrawals w
    WHERE w.kind='product' AND w.content_id=p.id
) AND NOT EXISTS (
    SELECT 1 FROM v2_products next WHERE next.predecessor_id=p.id
) AND NOT EXISTS (
    SELECT 1 FROM v2_content_merges m WHERE m.kind='product' AND m.from_id=p.id
)"""
# Current, and part of the catalogue: barcode-only products (details at Open Food Facts) are left out.
CURRENT_PRODUCT = "NOT p.off_reference AND " + LIVE_PRODUCT
# The order products are listed in: by brand, then name, then id so that ties stay stable.
DISPLAY_ORDER = "lower(p.data->>'brand'), lower(p.data->>'name'), p.id"
