"""Public category catalogue and compact, store-aware product search."""

from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, field_validator

from app.api.v2.auth import _bump_limit, _connect, _current_user, _limit_key, _secure_write
from app.api.v2.prices import _day
from app.api.v2.products import _product
from app.services.v2_price_history import COMPACT_HISTORY_CTE
from app.services.v2_catalogue_hierarchy import UNCATEGORIZED

router = APIRouter(prefix="/api/v2/catalogue", tags=["v2-catalogue"])

# A catalogue category is the existing comparable group, never a second field.
CATEGORY = "COALESCE(NULLIF(btrim(p.data->>'group'), ''), 'Sans groupe')"
CURRENT = """NOT EXISTS (
    SELECT 1 FROM v2_content_withdrawals w
    WHERE w.kind='product' AND w.content_id=p.id
) AND NOT EXISTS (
    SELECT 1 FROM v2_products next WHERE next.predecessor_id=p.id
) AND NOT EXISTS (
    SELECT 1 FROM v2_content_merges m WHERE m.kind='product' AND m.from_id=p.id
)"""
STORE_MATCH = """EXISTS (
    SELECT 1 FROM v2_price_observations o
    WHERE o.product_id=p.id AND o.store_id=$3
      AND EXISTS (SELECT 1 FROM v2_stores s WHERE s.id=o.store_id AND s.active)
      AND NOT o.superseded
      AND o.correction_status IS DISTINCT FROM 'active'
)"""


def _classification(row) -> dict:
    return {
        "department": row["department"] if row else UNCATEGORIZED,
        "family": row["family"] if row else UNCATEGORIZED,
        "comparison_scope": row["comparison_scope"] if row else None,
        "classification_source": row["source"] if row else "unclassified",
        "classification_revision": row["revision"] if row else 0,
    }


class ClassificationUpdate(BaseModel):
    department: str = Field(min_length=1, max_length=80)
    family: str = Field(min_length=1, max_length=80)
    comparison_scope: str | None = Field(default=None, max_length=80)
    base_revision: int = Field(ge=0)

    @field_validator("department", "family")
    @classmethod
    def clean_label(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("Le classement ne peut pas être vide.")
        return value

    @field_validator("comparison_scope")
    @classmethod
    def clean_scope(cls, value: str | None) -> str | None:
        return " ".join(value.split()) or None if value is not None else None


@router.get("/categories")
async def list_categories():
    connection = await _connect()
    try:
        rows = await connection.fetch(
            f"""SELECT min(v.category) AS name, count(*) AS product_count,
                       c.department,c.family,c.comparison_scope,c.source,c.revision
                FROM (SELECT {CATEGORY} AS category FROM v2_products p
                      WHERE {CURRENT}) v
                LEFT JOIN v2_catalogue_classifications c
                  ON c.group_key=lower(v.category)
                GROUP BY lower(v.category),c.department,c.family,c.comparison_scope,c.source,c.revision
                ORDER BY lower(min(v.category))"""
        )
        return [{"name": row["name"], "product_count": row["product_count"],
                 **_classification(row if row["source"] is not None else None)}
                for row in rows]
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
                WHERE s.active AND EXISTS (
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
                  AND s.active
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


MAX_BIGINT = 2**63 - 1
# The text searched is the product's fields joined with one space, runs of spaces collapsed, so that an
# empty or missing field does not change what a phrase spanning two fields matches. The browser filters
# the same way (v2-catalogue-search.ts); the shared fixture frontend/tests/fixtures/search-parity.json
# keeps both in agreement.
SEARCH_TEXT = ("lower(btrim(regexp_replace(concat_ws(' ', p.data->>'brand', p.data->>'name', "
               "p.data->>'commercial_name', p.data->>'quantity', p.data->>'ean'), '[ \\t\\n\\r\\f\\v]+', ' ', 'g')))")


def _collapse(text: str) -> str:
    return re.sub(r"[ \t\n\r\f\v]+", " ", text).strip()
# Typing triggers searches: bound them per client. Both budgets are charged only for admitted requests.
SUGGEST_PER_MINUTE = 10
SUGGEST_PER_HOUR = 100
SUGGEST_MIN_CHARS = 2
COMPLETE_LIST_BOUNDS = (5, 200)


def _search_conditions() -> str:
    return f"""{CURRENT}
            AND ($1='' OR strpos({SEARCH_TEXT}, lower($1)) > 0)
            AND ($2='' OR lower({CATEGORY})=lower($2))
            AND ($3::bigint IS NULL OR {STORE_MATCH})"""


@router.get("/search")
async def search_products(
    q: str = Query("", max_length=120),
    category: str = Query("", max_length=100),
    store_id: int | None = Query(None, ge=1, le=MAX_BIGINT),
    limit: int = Query(20, ge=1, le=50),
    offset: int = Query(0, ge=0, le=100000),
):
    connection = await _connect()
    try:
        conditions = _search_conditions()
        parameters = _collapse(q), category.strip(), store_id
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


async def _charge_search(connection, request: Request) -> None:
    """Spend one unit of the per-client minute and hour budgets, or refuse with the wait time."""
    for kind, seconds, allowed in (("catalogue-suggest-minute", 60, SUGGEST_PER_MINUTE),
                                   ("catalogue-suggest-hour", 3600, SUGGEST_PER_HOUR)):
        key = _limit_key(kind, request)
        if await _bump_limit(connection, key, seconds) > allowed:
            wait = await connection.fetchval(
                "SELECT greatest(1, ceil(extract(epoch FROM window_started_at "
                "+ ($2 * interval '1 second') - now())))::int FROM v2_auth_limits WHERE key=$1",
                key, seconds)
            raise HTTPException(
                status_code=429, headers={"Retry-After": str(wait or seconds)},
                detail="Trop de recherches. Réessayez dans quelques instants.")


@router.get("/suggest")
async def suggest_products(
    request: Request,
    q: str = Query("", max_length=120),
    category: str = Query("", max_length=100),
    store_id: int | None = Query(None, ge=1, le=MAX_BIGINT),
):
    """The complete list of matches, only when there are few enough; otherwise just their number.

    The browser filters a list it holds as the text grows, so a request is needed again
    only when a search is too broad to be listed or the text no longer extends a known one.
    """
    if len(_collapse(q)) < SUGGEST_MIN_CHARS:
        raise HTTPException(status_code=422, detail=f"Saisissez au moins {SUGGEST_MIN_CHARS} caractères.")
    connection = await _connect()
    try:
        await _charge_search(connection, request)
        limit = await connection.fetchval("SELECT complete_list_max FROM v2_search_settings WHERE singleton")
        conditions = _search_conditions()
        parameters = _collapse(q), category.strip(), store_id
        total = await connection.fetchval(
            f"SELECT count(*) FROM v2_products p WHERE {conditions}", *parameters)
        complete = total <= limit
        rows = await connection.fetch(
            f"""SELECT p.* FROM v2_products p WHERE {conditions}
                ORDER BY lower(p.data->>'brand'), lower(p.data->>'name'), p.id LIMIT $4""",
            *parameters, limit) if complete and total else []
        return {"total": total, "complete": complete, "max": limit,
                "items": [_product(row) for row in rows]}
    finally:
        await connection.close()


class SearchSettingsChange(BaseModel):
    complete_list_max: int = Field(ge=COMPLETE_LIST_BOUNDS[0], le=COMPLETE_LIST_BOUNDS[1])
    expected_revision: int = Field(ge=0)


async def _search_settings(connection) -> dict:
    row = await connection.fetchrow(
        "SELECT complete_list_max,revision FROM v2_search_settings WHERE singleton")
    return {"complete_list_max": row["complete_list_max"], "revision": row["revision"],
            "min": COMPLETE_LIST_BOUNDS[0], "max": COMPLETE_LIST_BOUNDS[1],
            "per_minute": SUGGEST_PER_MINUTE, "per_hour": SUGGEST_PER_HOUR}


async def _require_admin_user(connection, request: Request) -> None:
    user = await _current_user(connection, request)
    if user is None or user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Accès administrateur requis.")


@router.get("/search-settings")
async def read_search_settings(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        await _require_admin_user(connection, request)
        return await _search_settings(connection)
    finally:
        await connection.close()


@router.put("/search-settings")
async def change_search_settings(payload: SearchSettingsChange, request: Request, response: Response):
    _secure_write(request)
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        await _require_admin_user(connection, request)
        updated = await connection.fetchval(
            "UPDATE v2_search_settings SET complete_list_max=$1, revision=revision+1, updated_at=now() "
            "WHERE singleton AND revision=$2 RETURNING revision",
            payload.complete_list_max, payload.expected_revision)
        if updated is None:
            raise HTTPException(status_code=409, detail="Réglage modifié entre-temps. Rechargez la page.")
        return await _search_settings(connection)
    finally:
        await connection.close()


async def _recent_observations(connection, ids: list[int]) -> list[dict]:
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
    return [
        {"id": row["id"], "product_id": row["product_id"],
         "price": str(row["price"]), "observed_at": _day(row["observed_at"]),
         "retailer": row["retailer"], "store_name": row["store_name"],
         "city": row["city"]}
        for row in observations
    ]


async def scope_rows(connection, department: str, family: str, scope: str, limit: int | None = None):
    """The current products of a comparison scope, in display order."""
    return await connection.fetch(
        f"""SELECT p.*, {CATEGORY} AS category_name
            FROM v2_products p
            JOIN v2_catalogue_classifications c
              ON c.group_key=lower({CATEGORY})
            WHERE {CURRENT}
              AND lower(c.department)=lower($1)
              AND lower(c.family)=lower($2)
              AND lower(c.comparison_scope)=lower($3)
            ORDER BY lower(p.data->>'brand'), lower(p.data->>'name'), p.id
            LIMIT $4""",
        department, family, scope, limit,
    )


async def group_rows(connection, name: str, limit: int | None = None):
    """The current products of a comparable group, in display order."""
    return await connection.fetch(
        f"""SELECT p.*, {CATEGORY} AS category_name
            FROM v2_products p WHERE {CURRENT}
              AND lower({CATEGORY})=lower($1)
            ORDER BY lower(p.data->>'brand'), lower(p.data->>'name'), p.id
            LIMIT $2""",
        name, limit,
    )


@router.get("/comparison")
async def comparison_scope_detail(
    department: str = Query(..., min_length=1, max_length=80),
    family: str = Query(..., min_length=1, max_length=80),
    scope: str = Query(..., min_length=1, max_length=80),
):
    """Read a curated union of published products across precise groups."""
    connection = await _connect()
    try:
        rows = await scope_rows(connection, department, family, scope)
        if not rows:
            raise HTTPException(status_code=404, detail="Ensemble de comparaison introuvable.")
        groups: dict[str, dict] = {}
        for row in rows:
            key = row["category_name"].casefold()
            if key not in groups:
                groups[key] = {"name": row["category_name"], "product_count": 0}
            groups[key]["product_count"] += 1
        return {
            "name": scope, "department": department, "family": family,
            "comparison_scope": scope,
            "groups": sorted(groups.values(), key=lambda item: item["name"].casefold()),
            "products": [_product(row) for row in rows],
            "observations": await _recent_observations(connection, [row["id"] for row in rows]),
            "history_limit_per_product": 30,
        }
    finally:
        await connection.close()


@router.get("/categories/{name:path}")
async def category_detail(name: str):
    if not name or len(name) > 100:
        raise HTTPException(status_code=404, detail="Catégorie introuvable.")
    connection = await _connect()
    try:
        rows = await group_rows(connection, name)
        if not rows:
            raise HTTPException(status_code=404, detail="Catégorie introuvable.")
        observations = await _recent_observations(connection, [row["id"] for row in rows])
        classification = await connection.fetchrow(
            "SELECT department,family,comparison_scope,source,revision FROM v2_catalogue_classifications "
            "WHERE group_key=lower($1)", rows[0]["category_name"],
        )
        return {
            "name": rows[0]["category_name"],
            **_classification(classification),
            "products": [_product(row) for row in rows],
            "observations": observations,
            "history_limit_per_product": 30,
        }
    finally:
        await connection.close()


@router.put("/categories/{name:path}/classification")
async def update_category_classification(
    name: str, payload: ClassificationUpdate, request: Request,
):
    """An admin classifies the comparable group; products and recipes stay intact."""
    _secure_write(request)
    if not name or len(name) > 100:
        raise HTTPException(status_code=404, detail="Groupe comparable introuvable.")
    connection = await _connect()
    try:
        user = await _current_user(connection, request)
        if user is None or user["role"] != "admin":
            raise HTTPException(status_code=403, detail="Accès administrateur requis.")
        async with connection.transaction():
            group = await connection.fetchval(
                f"SELECT min({CATEGORY}) FROM v2_products p WHERE {CURRENT} "
                f"AND lower({CATEGORY})=lower($1)", name,
            )
            if group is None:
                raise HTTPException(status_code=404, detail="Groupe comparable introuvable.")
            current = await connection.fetchrow(
                "SELECT revision,comparison_scope FROM v2_catalogue_classifications "
                "WHERE group_key=lower($1) FOR UPDATE", group,
            )
            if (current["revision"] if current else 0) != payload.base_revision:
                raise HTTPException(status_code=409, detail="Ce classement a changé. Rechargez-le avant de réessayer.")
            scope = (payload.comparison_scope if "comparison_scope" in payload.model_fields_set
                     else current["comparison_scope"] if current else None)
            if current:
                row = await connection.fetchrow(
                    "UPDATE v2_catalogue_classifications SET department=$2,family=$3,"
                    "comparison_scope=$4,source='manual',revision=revision+1,updated_at=now() "
                    "WHERE group_key=lower($1) "
                    "RETURNING department,family,comparison_scope,source,revision",
                    group, payload.department, payload.family, scope,
                )
            else:
                row = await connection.fetchrow(
                    "INSERT INTO v2_catalogue_classifications "
                    "(group_key,group_name,department,family,comparison_scope,source) "
                    "VALUES(lower($1),$1,$2,$3,$4,'manual') ON CONFLICT DO NOTHING "
                    "RETURNING department,family,comparison_scope,source,revision",
                    group, payload.department, payload.family, scope,
                )
                if row is None:
                    raise HTTPException(status_code=409, detail="Ce classement a changé. Rechargez-le avant de réessayer.")
        return {"name": group, **_classification(row)}
    finally:
        await connection.close()
