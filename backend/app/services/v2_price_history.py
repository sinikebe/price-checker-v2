"""Price-history display boundaries shared by product and category views.

Keep every observation in storage. Only consecutive available Open Prices reports
with the same price within a product/store/channel form one display run.
"""
from __future__ import annotations

COMPACT_HISTORY_CTE = """
WITH ordered AS (
    SELECT o.id,o.product_id,o.retailer_id,o.store_id,o.price,o.observed_at,
           o.sales_channel,o.source,o.source_provider,o.available,
           o.correction_status,o.note,
           (o.observed_at AT TIME ZONE 'Europe/Paris')::date AS observed_day,
           lag(o.source_provider) OVER series AS previous_provider,
           lag(o.price) OVER series AS previous_price,
           lag(o.available) OVER series AS previous_available,
           lag(o.correction_status) OVER series AS previous_correction
    FROM v2_price_observations o
    WHERE o.product_id=ANY($1::bigint[]) AND NOT o.superseded
    WINDOW series AS (
        PARTITION BY o.product_id,o.store_id,o.sales_channel
        ORDER BY o.observed_at,o.id
    )
), runs AS (
    SELECT ordered.*,
           sum(CASE WHEN source_provider='open_prices'
                         AND previous_provider='open_prices'
                         AND available AND previous_available
                         AND correction_status IS DISTINCT FROM 'active'
                         AND previous_correction IS DISTINCT FROM 'active'
                         AND price IS NOT DISTINCT FROM previous_price
                         AND correction_status IS NOT DISTINCT
                             FROM previous_correction
                    THEN 0 ELSE 1 END) OVER (
               PARTITION BY product_id,store_id,sales_channel
               ORDER BY observed_at,id
           ) AS run_number
    FROM ordered
), boundaries AS (
    SELECT runs.*,
           row_number() OVER (
               PARTITION BY product_id,store_id,sales_channel,run_number
               ORDER BY observed_at,id
           ) AS first_in_run,
           row_number() OVER (
               PARTITION BY product_id,store_id,sales_channel,run_number
               ORDER BY observed_at DESC,id DESC
           ) AS last_in_run,
           min(observed_day) OVER (
               PARTITION BY product_id,store_id,sales_channel,run_number
           ) AS first_day,
           max(observed_day) OVER (
               PARTITION BY product_id,store_id,sales_channel,run_number
           ) AS last_day
    FROM runs
), compact_history AS (
    SELECT * FROM boundaries
    WHERE last_in_run=1 OR (first_in_run=1 AND first_day<>last_day)
)
"""
