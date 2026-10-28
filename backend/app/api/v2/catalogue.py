"""Public category catalogue and compact, store-aware product search."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.api.v2.auth import _connect
from app.api.v2.prices import _day
from app.api.v2.products import _product
from app.services.v2_price_history import COMPACT_HISTORY_CTE

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


# Published records may predate the current publication rules. Optional
# fields are enrichment opportunities, not blockers for public visibility.
PRODUCT_REQUIRED = {"name": "nom", "brand": "marque",
                    "package": "conditionnement", "quantity": "quantité"}
PRODUCT_OPTIONAL = {"ean": "code-barres", "composition": "composition"}


@router.get("/to-complete")
async def to_complete(
    priority: str = Query("required", pattern="^(required|optional)$"),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    connection = await _connect()
    try:
        products = await connection.fetch(
            f"SELECT p.* FROM v2_products p WHERE {CURRENT} ORDER BY p.id"
        )
        # A store enters this public list only after a public observation exists.
        # Private drafts must never expose their store names here.
        stores = await connection.fetch(
            f"""SELECT s.id,s.name,s.city,s.postal_code,r.name AS retailer
                FROM v2_stores s JOIN v2_retailers r ON r.id=s.retailer_id
                WHERE EXISTS (
                    SELECT 1 FROM v2_price_observations o
                    JOIN v2_products p ON p.id=o.product_id
                    WHERE o.store_id=s.id AND NOT o.superseded AND {CURRENT})
                ORDER BY s.id"""
        )
        required = []
        optional = []
        for row in products:
            item = _product(row)
            data = item["data"]
            missing_required = [label for key, label in PRODUCT_REQUIRED.items()
                                if not (data.get(key) or "").strip()]
            missing_optional = [label for key, label in PRODUCT_OPTIONAL.items()
                                if not (data.get(key) or "").strip()]
            summary = {"kind": "product", "id": item["id"], "name": data.get("name") or "",
                       "brand": data.get("brand") or "",
                       "missing": missing_required or missing_optional}
            if missing_required:
                required.append(summary)
            elif missing_optional:
                optional.append(summary)
        for row in stores:
            missing = [label for key, label in (("city", "ville"), ("postal_code", "code postal"))
                       if not (row[key] or "").strip()]
            if missing:
                required.append({"kind": "store", "id": row["id"], "name": row["name"],
                                 "retailer": row["retailer"], "city": row["city"] or "",
                                 "postal_code": row["postal_code"] or "", "missing": missing})
        selected = required if priority == "required" else optional
        return {"items": selected[offset:offset + limit], "total": len(selected),
                "required_total": len(required), "optional_total": len(optional),
                "limit": limit, "offset": offset}
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
            COMPACT_HISTORY_CTE + """
            SELECT * FROM (
                SELECT c.id,c.product_id,c.price,c.observed_at,
                       r.name AS retailer,s.name AS store_name,s.city,
                       row_number() OVER (
                           PARTITION BY c.product_id
                           ORDER BY c.observed_at DESC,c.id DESC
                       ) AS rank
                FROM compact_history c
                JOIN v2_retailers r ON r.id=c.retailer_id
                JOIN v2_stores s ON s.id=c.store_id
                WHERE c.available
                  AND c.correction_status IS DISTINCT FROM 'active'
            ) recent WHERE rank<=30
            ORDER BY observed_at,id
            """,
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
