"""Public category catalogue and compact, store-aware product search."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.api.v2.auth import _connect
from app.api.v2.prices import _day
from app.api.v2.products import _product

router = APIRouter(prefix="/api/v2/catalogue", tags=["v2-catalogue"])

# A catalogue category is the existing comparable group, never a second field.
CATEGORY = "COALESCE(NULLIF(btrim(p.data->>'group'), ''), 'Sans groupe')"
CURRENT = """NOT EXISTS (
    SELECT 1 FROM v2_content_withdrawals w
    WHERE w.kind='product' AND w.content_id=p.id
) AND NOT EXISTS (
    SELECT 1 FROM v2_products next WHERE next.predecessor_id=p.id
)"""
STORE_MATCH = """EXISTS (
    SELECT 1 FROM v2_price_observations o
    WHERE o.product_id=p.id AND o.store_id=$3
      AND NOT o.superseded
      AND o.correction_status IS DISTINCT FROM 'active'
)"""


@router.get("/categories")
async def list_categories():
    connection = await _connect()
    try:
        rows = await connection.fetch(
            f"""SELECT min(category) AS name, count(*) AS product_count
                FROM (SELECT {CATEGORY} AS category FROM v2_products p
                      WHERE {CURRENT}) visible
                GROUP BY lower(category)
                ORDER BY lower(min(category))"""
        )
        return [dict(row) for row in rows]
    finally:
        await connection.close()


@router.get("/stores")
async def find_stores(q: str = Query("", max_length=80)):
    if len(q.strip()) < 2:
        return []
    connection = await _connect()
    try:
        rows = await connection.fetch(
            f"""SELECT s.id, r.name AS retailer, s.name, s.city, s.postal_code
                FROM v2_stores s JOIN v2_retailers r ON r.id=s.retailer_id
                WHERE strpos(lower(concat_ws(' ', r.name, s.name, s.city,
                                             s.postal_code)), lower($1)) > 0
                  AND EXISTS (
                      SELECT 1 FROM v2_price_observations o
                      JOIN v2_products p ON p.id=o.product_id
                      WHERE o.store_id=s.id AND NOT o.superseded
                        AND o.correction_status IS DISTINCT FROM 'active'
                        AND {CURRENT}
                  )
                ORDER BY lower(r.name), lower(s.name), lower(s.city), s.id
                LIMIT 20""",
            q.strip(),
        )
        return [dict(row) for row in rows]
    finally:
        await connection.close()


@router.get("/search")
async def search_products(
    q: str = Query("", max_length=120),
    category: str = Query("", max_length=100),
    store_id: int | None = Query(None, ge=1),
    limit: int = Query(20, ge=1, le=50),
    offset: int = Query(0, ge=0, le=100000),
):
    connection = await _connect()
    try:
        conditions = f"""{CURRENT}
            AND ($1='' OR strpos(lower(concat_ws(' ', p.data->>'brand',
                p.data->>'name', p.data->>'commercial_name',
                p.data->>'quantity', p.data->>'ean')), lower($1)) > 0)
            AND ($2='' OR lower({CATEGORY})=lower($2))
            AND ($3::bigint IS NULL OR {STORE_MATCH})"""
        parameters = q.strip(), category.strip(), store_id
        total = await connection.fetchval(
            f"SELECT count(*) FROM v2_products p WHERE {conditions}", *parameters
        )
        rows = await connection.fetch(
            f"""SELECT p.* FROM v2_products p WHERE {conditions}
                ORDER BY lower(p.data->>'brand'), lower(p.data->>'name'), p.id
                LIMIT $4 OFFSET $5""",
            *parameters, limit, offset,
        )
        return {"items": [_product(row) for row in rows], "total": total,
                "limit": limit, "offset": offset}
    finally:
        await connection.close()


@router.get("/categories/{name}")
async def category_detail(name: str):
    if not name or len(name) > 100:
        raise HTTPException(status_code=404, detail="Catégorie introuvable.")
    connection = await _connect()
    try:
        rows = await connection.fetch(
            f"""SELECT p.*, {CATEGORY} AS category_name
                FROM v2_products p WHERE {CURRENT}
                  AND lower({CATEGORY})=lower($1)
                ORDER BY lower(p.data->>'brand'), lower(p.data->>'name'), p.id""",
            name,
        )
        if not rows:
            raise HTTPException(status_code=404, detail="Catégorie introuvable.")
        ids = [row["id"] for row in rows]
        observations = await connection.fetch(
            """SELECT * FROM (
                 SELECT o.id, o.product_id, o.price, o.observed_at,
                        r.name AS retailer, s.name AS store_name, s.city,
                        row_number() OVER (
                          PARTITION BY o.product_id
                          ORDER BY o.observed_at DESC, o.id DESC
                        ) AS rank
                 FROM v2_price_observations o
                 JOIN v2_retailers r ON r.id=o.retailer_id
                 JOIN v2_stores s ON s.id=o.store_id
                 WHERE o.product_id=ANY($1::bigint[]) AND NOT o.superseded
                   AND o.available
                   AND o.correction_status IS DISTINCT FROM 'active'
               ) recent WHERE rank<=30
               ORDER BY observed_at, id""",
            ids,
        )
        return {
            "name": rows[0]["category_name"],
            "products": [_product(row) for row in rows],
            "observations": [
                {"id": row["id"], "product_id": row["product_id"],
                 "price": str(row["price"]), "observed_at": _day(row["observed_at"]),
                 "retailer": row["retailer"], "store_name": row["store_name"],
                 "city": row["city"]}
                for row in observations
            ],
            "history_limit_per_product": 30,
        }
    finally:
        await connection.close()
