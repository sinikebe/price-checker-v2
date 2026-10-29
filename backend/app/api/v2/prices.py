"""Published V2 price observations and moderated, product-specific price drafts."""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, time
from decimal import Decimal
from typing import Literal
from zoneinfo import ZoneInfo

import asyncpg
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator, model_validator

from app.api.v2.auth import _connect, _current_user, _secure_write
from app.api.v2.off import normalize_barcode
from app.api.v2.products import ProductData
from app.api.v2.stores import AliasSource, propose_alias, visible_store
from app.core.url_validation import validate_clickable_url
from app.services.v2_price_history import COMPACT_HISTORY_CTE
from app.services.v2_visibility import require_visible
from app.services.v2_write_limits import (
    MAX_PRICE_DRAFTS,
    MAX_PRODUCT_DRAFTS,
    check_open_limit,
    check_write_limit,
)

router = APIRouter(prefix="/api/v2/prices", tags=["v2-prices"])
_PARIS = ZoneInfo("Europe/Paris")


def _day(value: datetime) -> str:
    return value.astimezone(_PARIS).date().isoformat()


class PriceDraftCreate(BaseModel):
    retailer: str = Field(min_length=1, max_length=200)
    store_name: str = Field(min_length=1, max_length=300)
    city: str = Field(default="", max_length=200)
    postal_code: str = Field(default="", max_length=20)
    sales_channel: Literal["in_store", "drive", "delivery"] = "in_store"
    price: Decimal = Field(ge=0, max_digits=10, decimal_places=2)
    observed_at: datetime
    note: str = Field(default="", max_length=1000)
    store_id: int | None = Field(default=None, ge=1)
    captured_store_name: str | None = Field(default=None, max_length=300)
    propose_store_alias: bool = False
    alias_source: AliasSource = "retailer"

    @field_validator("retailer", "store_name", "city", "postal_code", "note")
    @classmethod
    def strip_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("retailer", "store_name")
    @classmethod
    def require_name(cls, value: str) -> str:
        if not value:
            raise ValueError("L’enseigne, le point de vente et la ville ou zone sont nécessaires.")
        return value

    @model_validator(mode="after")
    def alias_requires_store(self):
        if self.store_id is None and (not self.city or not self.postal_code):
            raise ValueError("Indiquez la ville et le code postal du nouveau magasin.")
        if self.propose_store_alias and (self.store_id is None or not self.captured_store_name):
            raise ValueError("Choisissez un magasin existant et indiquez son nom capturé.")
        return self

    @field_validator("observed_at", mode="before")
    @classmethod
    def parse_day(cls, value):
        if isinstance(value, str) and len(value) == 10:
            return datetime.combine(date.fromisoformat(value), time(12), tzinfo=_PARIS)
        return value

    @field_validator("observed_at")
    @classmethod
    def valid_date(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Indiquez une date et un fuseau horaire.")
        day = value.astimezone(_PARIS).date()
        if day > datetime.now(_PARIS).date():
            raise ValueError("Un prix ne peut pas être relevé dans le futur.")
        return datetime.combine(day, time(12), tzinfo=_PARIS)


class CaptureDraftCreate(BaseModel):
    ean: str = Field(max_length=14)
    product_draft_id: int | None = Field(default=None, ge=1)
    product_data: ProductData | None = None
    source_url: str = Field(max_length=1000)
    price: PriceDraftCreate

    @field_validator("source_url")
    @classmethod
    def valid_source_url(cls, value: str) -> str:
        return validate_clickable_url(value.strip(), "source_url")

    @model_validator(mode="after")
    def one_product_target(self):
        if (self.product_draft_id is None) == (self.product_data is None):
            raise ValueError("Indiquez une fiche existante ou les données du nouveau brouillon.")
        return self


class PublishedCaptureCreate(BaseModel):
    ean: str = Field(max_length=14)
    source_url: str = Field(max_length=1000)
    price: PriceDraftCreate

    @field_validator("source_url")
    @classmethod
    def valid_source_url(cls, value: str) -> str:
        return validate_clickable_url(value.strip(), "source_url")


async def _user(connection: asyncpg.Connection, request: Request) -> dict:
    user = await _current_user(connection, request)
    if user is None:
        raise HTTPException(status_code=401, detail="Connectez-vous pour proposer un prix.")
    return user


async def _product(connection: asyncpg.Connection, product_id: int, *, current: bool = False) -> None:
    await require_visible(connection, "product", product_id)
    exists = await connection.fetchval(
        "SELECT EXISTS(SELECT 1 FROM v2_products WHERE id=$1)", product_id
    )
    if not exists:
        raise HTTPException(status_code=404, detail="Produit introuvable.")
    if current and await connection.fetchval(
        "SELECT EXISTS(SELECT 1 FROM v2_products WHERE predecessor_id=$1 "
        "UNION ALL SELECT 1 FROM v2_content_merges WHERE kind='product' AND from_id=$1)", product_id
    ):
        raise HTTPException(
            status_code=409,
            detail="Cette référence a été remplacée. Relevez le prix sur sa version actuelle.",
        )


def _hash(value: str) -> str:
    return hashlib.sha256(value.casefold().encode("utf-8")).hexdigest()[:32]


async def _barcode_belongs_to_product(
    connection: asyncpg.Connection, product_id: int, barcode: str,
) -> bool:
    return bool(await connection.fetchval(
        "SELECT EXISTS(SELECT 1 FROM v2_products p "
        "LEFT JOIN v2_content_merges m ON m.kind='product' AND m.from_id=p.id "
        "WHERE COALESCE(m.to_id,p.id)=$1 "
        "AND p.data->>'ean'<>'' "
        "AND lpad(p.data->>'ean',14,'0')=lpad($2,14,'0') "
        "AND NOT EXISTS(SELECT 1 FROM v2_products next "
        "WHERE next.predecessor_id=p.id))",
        product_id, barcode,
    ))


async def _retailer_store(
    connection: asyncpg.Connection, payload: PriceDraftCreate, user: dict,
) -> tuple[int, int, int | None, int | None]:
    # New locations must not cross a concurrent permanent deletion between
    # the source-tombstone check and their insert. Lifecycle actions use this
    # lock before taking a store row lock.
    if payload.store_id is None:
        await connection.execute("SELECT pg_advisory_xact_lock(795244, 1)")
    retailer_id = await connection.fetchval(
        "SELECT id FROM v2_retailers WHERE lower(name)=lower($1) ORDER BY id LIMIT 1",
        payload.retailer,
    )
    if payload.store_id is not None:
        store = await visible_store(connection, payload.store_id, user)
        source_group_id = await connection.fetchval(
            "SELECT group_id FROM v2_retailers WHERE id=$1", retailer_id,
        )
        if source_group_id is None or source_group_id != store["retailer_group_id"]:
            raise HTTPException(status_code=422, detail="Le magasin ne correspond pas au groupe d’enseignes.")
        if not (store["city"] or "").strip() or not (store["postal_code"] or "").strip():
            raise HTTPException(status_code=422, detail="Ce magasin doit être complété avant un nouveau relevé.")
        if (store["name"] != payload.store_name or
                (store["city"] or "") != payload.city or
                (store["postal_code"] or "") != payload.postal_code):
            raise HTTPException(status_code=409, detail="Le magasin a changé. Rechargez ses informations.")
        alias_id = None
        if payload.propose_store_alias:
            alias_id = await propose_alias(
                connection, store_id=payload.store_id, author_id=user["id"],
                source=payload.alias_source, name=payload.captured_store_name or "",
            )
        return (store["retailer_id"], payload.store_id, alias_id,
                retailer_id if retailer_id != store["retailer_id"] else None)
    if payload.propose_store_alias:
        raise HTTPException(status_code=422, detail="Sélectionnez un magasin existant pour proposer un alias.")
    if retailer_id is None:
        code = "manual-" + _hash(payload.retailer)[:24]
        retailer_id = await connection.fetchval(
            "INSERT INTO v2_retailers(code,name) VALUES($1,$2) "
            "ON CONFLICT(code) DO UPDATE SET code=EXCLUDED.code RETURNING id",
            code, payload.retailer,
        )
    identity = "|".join((
        str(retailer_id), payload.store_name, payload.city, payload.postal_code
    ))
    import_key = "manual:store:" + _hash(identity)
    if await connection.fetchval(
        "SELECT EXISTS(SELECT 1 FROM v2_deleted_store_sources WHERE source_key=$1)",
        "import:" + import_key,
    ):
        raise HTTPException(status_code=409, detail="Ce magasin a été supprimé définitivement.")
    store_id = await connection.fetchval(
        "INSERT INTO v2_stores(retailer_id,name,city,postal_code,import_key) "
        "VALUES($1,$2,$3,$4,$5) ON CONFLICT(import_key) DO UPDATE "
        "SET import_key=EXCLUDED.import_key RETURNING id",
        retailer_id, payload.store_name, payload.city or None,
        payload.postal_code or None, import_key,
    )
    canonical = await connection.fetchrow(
        "SELECT COALESCE(m.to_id,s.id) AS store_id,"
        "c.retailer_id AS retailer_id,c.active FROM v2_stores s "
        "LEFT JOIN v2_content_merges m ON m.kind='store' AND m.from_id=s.id "
        "JOIN v2_stores c ON c.id=COALESCE(m.to_id,s.id) "
        "WHERE s.id=$1", store_id,
    )
    if not canonical["active"]:
        raise HTTPException(status_code=409, detail="Ce magasin est désactivé.")
    if canonical["retailer_id"] != retailer_id:
        same_group = await connection.fetchval(
            "SELECT a.group_id=b.group_id FROM v2_retailers a "
            "JOIN v2_retailers b ON b.id=$2 WHERE a.id=$1",
            retailer_id, canonical["retailer_id"],
        )
        if not same_group:
            raise HTTPException(status_code=409, detail="Le magasin fusionné a changé d’enseigne.")
    return (canonical["retailer_id"], canonical["store_id"], None,
            retailer_id if retailer_id != canonical["retailer_id"] else None)


def _observation(row: asyncpg.Record) -> dict:
    return {
        "id": row["id"],
        "price": str(row["price"]),
        "observed_at": _day(row["observed_at"]),
        "retailer": row["retailer"],
        "retailer_id": row["retailer_id"],
        "source_retailer": row["source_retailer"],
        "store_name": row["store_name"],
        "store_id": row["store_id"],
        "city": row["city"],
        "postal_code": row["postal_code"],
        "sales_channel": row["sales_channel"],
        "source": row["source"],
        "source_provider": row["source_provider"],
        "available": row["available"],
        "correction_status": row["correction_status"],
        "note": row["note"],
    }


def _draft(row: asyncpg.Record) -> dict:
    return {
        "id": row["id"],
        "author": row["author"],
        "author_id": row["author_id"],
        "price": str(row["price"]),
        "observed_at": _day(row["observed_at"]),
        "retailer": row["retailer"],
        "source_retailer": row["source_retailer"],
        "store_name": row["store_name"],
        "city": row["city"],
        "sales_channel": row["sales_channel"],
        "status": row["status"],
        "note": row["note"],
        "capture_ean": row["capture_ean"],
        "quantity_text": row["quantity_text"],
        "captured_store_name": row["captured_store_name"],
    }


@router.get("/products/{product_id}")
async def product_prices(product_id: int):
    connection = await _connect()
    try:
        await _product(connection, product_id)
        rows = await connection.fetch(
            COMPACT_HISTORY_CTE + """
            SELECT b.id,b.price,b.observed_at,b.sales_channel,b.source,
                   b.source_provider,b.available,b.correction_status,b.note,
                   r.name AS retailer,r.id AS retailer_id,
                   sr.name AS source_retailer,s.name AS store_name,
                   s.id AS store_id,s.city,s.postal_code
            FROM compact_history b
            JOIN v2_retailers r ON r.id=b.retailer_id
            LEFT JOIN v2_retailers sr ON sr.id=b.source_retailer_id
            JOIN v2_stores s ON s.id=b.store_id
            ORDER BY b.observed_at DESC,b.id DESC LIMIT 201
            """,
            [product_id],
        )
        # The chart history is capped, but a store with an older last reading
        # must not disappear from the current comparison. Keep channels apart.
        latest_rows = await connection.fetch(
            """
            SELECT * FROM (
                SELECT DISTINCT ON (o.store_id,o.sales_channel)
                       o.id,o.price,o.observed_at,o.sales_channel,o.source,
                       o.source_provider,o.available,o.correction_status,o.note,
                       r.name AS retailer,r.id AS retailer_id,
                       sr.name AS source_retailer,s.name AS store_name,
                       s.id AS store_id,s.city,s.postal_code
                FROM v2_price_observations o
                JOIN v2_retailers r ON r.id=o.retailer_id
                LEFT JOIN v2_retailers sr ON sr.id=o.source_retailer_id
                JOIN v2_stores s ON s.id=o.store_id
                WHERE o.product_id=$1 AND NOT o.superseded AND s.active
                ORDER BY o.store_id,o.sales_channel,o.observed_at DESC,o.id DESC
            ) latest
            ORDER BY latest.observed_at DESC,latest.id DESC LIMIT 201
            """,
            product_id,
        )
        return {
            "observations": [_observation(row) for row in rows[:200]],
            "truncated": len(rows) > 200,
            "latest_by_store": [_observation(row) for row in latest_rows[:200]],
            "stores_truncated": len(latest_rows) > 200,
        }
    finally:
        await connection.close()


@router.get("/products/{product_id}/drafts")
async def product_price_drafts(product_id: int, request: Request):
    connection = await _connect()
    try:
        user = await _user(connection, request)
        await _product(connection, product_id)
        rows = await connection.fetch(
            """
            SELECT d.id,d.author_id,u.username AS author,d.price,d.observed_at,
                   d.sales_channel,d.status,d.note,d.capture_ean,d.quantity_text,
                   d.captured_store_name,
                   r.name AS retailer,sr.name AS source_retailer,
                   s.name AS store_name,s.city
            FROM v2_price_drafts d
            JOIN v2_users u ON u.id=d.author_id
            JOIN v2_retailers r ON r.id=d.retailer_id
            LEFT JOIN v2_retailers sr ON sr.id=d.source_retailer_id
            JOIN v2_stores s ON s.id=d.store_id
            WHERE d.product_id=$1 AND s.active AND (d.author_id=$2 OR
                ($3='admin' AND d.status='draft'))
            ORDER BY d.updated_at DESC,d.id DESC LIMIT 100
            """,
            product_id, user["id"], user["role"],
        )
        return [_draft(row) for row in rows]
    finally:
        await connection.close()


async def _draft_inbox(connection, *, owner_id: int | None, limit: int, offset: int) -> dict:
    """List private price proposals independently of product proposals."""
    if owner_id is None:
        predicate = "d.status='draft'"
        parameters = []
        order = "ASC"
    else:
        predicate = "d.author_id=$1 AND d.status IN ('draft','rejected')"
        parameters = [owner_id]
        order = "DESC"
    total = await connection.fetchval(
        f"SELECT count(*) FROM v2_price_drafts d WHERE {predicate}", *parameters,
    )
    rows = await connection.fetch(
        f"""
        SELECT d.id,d.product_id,d.product_draft_id,d.author_id,
               u.username AS author,d.price,d.observed_at,d.sales_channel,
               d.status,d.note,d.capture_ean,d.quantity_text,d.captured_store_name,
               r.name AS retailer,sr.name AS source_retailer,
               s.name AS store_name,s.city,s.active AS store_active,
               COALESCE(p.data->>'name',pd.data->>'name','') AS product_name,
               COALESCE(p.data->>'brand',pd.data->>'brand','') AS product_brand
        FROM v2_price_drafts d
        JOIN v2_users u ON u.id=d.author_id
        JOIN v2_retailers r ON r.id=d.retailer_id
        LEFT JOIN v2_retailers sr ON sr.id=d.source_retailer_id
        JOIN v2_stores s ON s.id=d.store_id
        LEFT JOIN v2_products p ON p.id=d.product_id
        LEFT JOIN v2_product_drafts pd ON pd.id=d.product_draft_id
        WHERE {predicate}
        ORDER BY d.updated_at {order},d.id {order}
        LIMIT ${len(parameters) + 1} OFFSET ${len(parameters) + 2}
        """,
        *parameters, limit, offset,
    )
    return {"items": [{**_draft(row),
                       "product_id": row["product_id"],
                       "product_draft_id": row["product_draft_id"],
                       "product_name": row["product_name"],
                       "product_brand": row["product_brand"],
                       "store_active": row["store_active"]} for row in rows],
            "total": total, "limit": limit, "offset": offset}


@router.get("/drafts/mine")
async def my_price_drafts(
    request: Request,
    limit: int = Query(30, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    connection = await _connect()
    try:
        user = await _user(connection, request)
        return await _draft_inbox(
            connection, owner_id=user["id"], limit=limit, offset=offset,
        )
    finally:
        await connection.close()


@router.get("/drafts/review")
async def review_price_drafts(
    request: Request,
    limit: int = Query(30, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    connection = await _connect()
    try:
        user = await _user(connection, request)
        if user["role"] != "admin":
            raise HTTPException(status_code=403, detail="Réservé à l'administrateur.")
        return await _draft_inbox(
            connection, owner_id=None, limit=limit, offset=offset,
        )
    finally:
        await connection.close()


@router.post("/capture-drafts", status_code=201)
async def create_capture_drafts(payload: CaptureDraftCreate, request: Request):
    """Atomically submit a private product draft and its separately reviewed price."""
    _secure_write(request)
    barcode = normalize_barcode(payload.ean)
    if payload.product_data is not None and normalize_barcode(payload.product_data.ean) != barcode:
        raise HTTPException(status_code=422, detail="L’EAN de la fiche ne correspond pas à la capture.")
    connection = await _connect()
    try:
        user = await _user(connection, request)
        async with connection.transaction():
            await check_write_limit(connection, user)
            await check_open_limit(
                connection, user, table="v2_price_drafts", maximum=MAX_PRICE_DRAFTS,
            )
            if payload.product_draft_id is not None:
                draft = await connection.fetchrow(
                    "SELECT id,data FROM v2_product_drafts WHERE id=$1 "
                    "AND author_id=$2 AND product_id IS NULL AND status='draft' FOR UPDATE",
                    payload.product_draft_id, user["id"],
                )
                if draft is None:
                    raise HTTPException(status_code=404, detail="Brouillon privé introuvable.")
            else:
                draft = await connection.fetchrow(
                    "SELECT id,data FROM v2_product_drafts WHERE author_id=$1 "
                    "AND product_id IS NULL AND status='draft' AND data->>'ean' <> '' "
                    "AND lpad(data->>'ean',14,'0')=lpad($2,14,'0') "
                    "ORDER BY updated_at DESC,id DESC LIMIT 1 FOR UPDATE",
                    user["id"], barcode,
                )
            # Lock an existing draft before its GTIN advisory lock: approval
            # already takes these locks in that order. A new draft has no row.
            # Share the approval lock: a product published between lookup and
            # submission must not receive a second, competing initial draft.
            await connection.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(lpad($1,14,'0'),0))",
                barcode,
            )
            published = await connection.fetchval(
                "SELECT p.id FROM v2_products p WHERE p.data->>'ean' <> '' "
                "AND lpad(p.data->>'ean',14,'0')=lpad($1,14,'0') "
                "AND NOT EXISTS (SELECT 1 FROM v2_products next "
                "WHERE next.predecessor_id=p.id) "
                "AND NOT EXISTS (SELECT 1 FROM v2_content_withdrawals w "
                "WHERE w.kind='product' AND w.content_id=p.id) LIMIT 1",
                barcode,
            )
            if published is not None:
                raise HTTPException(
                    status_code=409,
                    detail="Ce produit est maintenant publié. Rechargez la capture pour lui proposer le prix.",
                )
            created = False
            if draft is None:
                await check_open_limit(
                    connection, user, table="v2_product_drafts", maximum=MAX_PRODUCT_DRAFTS,
                )
                draft = await connection.fetchrow(
                    "INSERT INTO v2_product_drafts(author_id,data) "
                    "VALUES($1,$2::jsonb) RETURNING id,data",
                    user["id"], payload.product_data.model_dump_json(),
                )
                created = True
            data = draft["data"]
            if isinstance(data, str):
                data = json.loads(data)
            if not data.get("ean") or data["ean"].zfill(14) != barcode.zfill(14):
                raise HTTPException(
                    status_code=409, detail="L’EAN du brouillon a changé. Rechargez la capture.",
                )
            retailer_id, store_id, alias_id, source_retailer_id = await _retailer_store(connection, payload.price, user)
            price_draft_id = await connection.fetchval(
                "INSERT INTO v2_price_drafts("
                "author_id,product_draft_id,retailer_id,store_id,entry_kind,captured_via,"
                "source_url,capture_ean,price,quantity_text,observed_at,note,sales_channel,"
                "captured_store_name,source_retailer_id) "
                "VALUES($1,$2,$3,$4,'capture','bookmarklet',$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id",
                user["id"], draft["id"], retailer_id, store_id,
                payload.source_url, barcode, payload.price.price,
                data.get("quantity") or None, payload.price.observed_at,
                payload.price.note or None, payload.price.sales_channel,
                payload.price.captured_store_name, source_retailer_id,
            )
        return {"product_draft_id": draft["id"], "price_draft_id": price_draft_id,
                "created_product_draft": created, "alias_proposal_id": alias_id,
                "status": "draft"}
    finally:
        await connection.close()


@router.post("/products/{product_id}/drafts", status_code=201)
async def create_price_draft(product_id: int, payload: PriceDraftCreate, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        async with connection.transaction():
            await check_write_limit(connection, user)
            await check_open_limit(
                connection, user, table="v2_price_drafts",
                maximum=MAX_PRICE_DRAFTS,
            )
            await _product(connection, product_id, current=True)
            retailer_id, store_id, alias_id, source_retailer_id = await _retailer_store(connection, payload, user)
            quantity = await connection.fetchval(
                "SELECT NULLIF(data->>'quantity','') FROM v2_products WHERE id=$1",
                product_id,
            )
            draft_id = await connection.fetchval(
                """
                INSERT INTO v2_price_drafts(
                    author_id,product_id,retailer_id,store_id,entry_kind,
                    price,quantity_text,observed_at,note,sales_channel,captured_store_name,
                    source_retailer_id)
                VALUES($1,$2,$3,$4,'manual',$5,$6,$7,$8,$9,$10,$11) RETURNING id
                """,
                user["id"], product_id, retailer_id, store_id, payload.price,
                quantity, payload.observed_at, payload.note or None,
                payload.sales_channel, payload.captured_store_name, source_retailer_id,
            )
        return {"id": draft_id, "status": "draft", "alias_proposal_id": alias_id}
    finally:
        await connection.close()


@router.post("/products/{product_id}/capture-drafts", status_code=201)
async def create_published_capture_draft(
    product_id: int, payload: PublishedCaptureCreate, request: Request,
):
    """Keep bookmarklet provenance when the catalogue product already exists."""
    _secure_write(request)
    barcode = normalize_barcode(payload.ean)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        async with connection.transaction():
            await check_write_limit(connection, user)
            await check_open_limit(
                connection, user, table="v2_price_drafts", maximum=MAX_PRICE_DRAFTS,
            )
            await _product(connection, product_id, current=True)
            product = await connection.fetchrow(
                "SELECT data->>'quantity' AS quantity "
                "FROM v2_products WHERE id=$1", product_id,
            )
            if not await _barcode_belongs_to_product(connection, product_id, barcode):
                raise HTTPException(status_code=409, detail="L’EAN du produit a changé. Rechargez la capture.")
            retailer_id, store_id, alias_id, source_retailer_id = await _retailer_store(connection, payload.price, user)
            draft_id = await connection.fetchval(
                "INSERT INTO v2_price_drafts("
                "author_id,product_id,retailer_id,store_id,entry_kind,captured_via,"
                "source_url,capture_ean,price,quantity_text,observed_at,note,sales_channel,"
                "captured_store_name,source_retailer_id) "
                "VALUES($1,$2,$3,$4,'capture','bookmarklet',$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id",
                user["id"], product_id, retailer_id, store_id,
                payload.source_url, barcode, payload.price.price,
                product["quantity"] or None, payload.price.observed_at,
                payload.price.note or None, payload.price.sales_channel,
                payload.price.captured_store_name, source_retailer_id,
            )
        return {"id": draft_id, "status": "draft", "alias_proposal_id": alias_id}
    finally:
        await connection.close()


async def _review(draft_id: int, request: Request, *, approve: bool) -> dict:
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        if user["role"] != "admin":
            raise HTTPException(status_code=403, detail="Validation réservée à l’administrateur.")
        async with connection.transaction():
            draft = await connection.fetchrow(
                "SELECT * FROM v2_price_drafts WHERE id=$1 FOR UPDATE", draft_id
            )
            if draft is None or draft["status"] != "draft":
                raise HTTPException(status_code=404, detail="Relevé à valider introuvable.")
            observation_id = None
            if approve:
                if not await connection.fetchval(
                    "SELECT active FROM v2_stores WHERE id=$1 FOR SHARE", draft["store_id"]
                ):
                    raise HTTPException(status_code=409, detail="Ce magasin est désactivé.")
                if draft["product_id"] is None:
                    raise HTTPException(
                        status_code=409,
                        detail="Validez d’abord la fiche produit, puis examinez son prix séparément.",
                    )
                await _product(connection, draft["product_id"], current=True)
                if draft["capture_ean"] is not None:
                    if not await _barcode_belongs_to_product(
                        connection, draft["product_id"], draft["capture_ean"]
                    ):
                        raise HTTPException(
                            status_code=409,
                            detail="L’EAN du produit a changé depuis la capture. Refusez ce prix.",
                        )
                observation_id = await connection.fetchval(
                    """
                    INSERT INTO v2_price_observations(
                        product_id,retailer_id,store_id,source,contributor_id,
                        price_draft_id,approved_by,approved_at,price,quantity_text,
                        observed_at,note,sales_channel,source_url,capture_ean,source_retailer_id)
                    VALUES($1,$2,$3,$12,$4,$5,$6,now(),$7,$8,$9,$10,$11,$13,$14,$15)
                    RETURNING id
                    """,
                    draft["product_id"], draft["retailer_id"], draft["store_id"],
                    draft["author_id"], draft_id, user["id"], draft["price"],
                    draft["quantity_text"], draft["observed_at"], draft["note"],
                    draft["sales_channel"],
                    "bookmarklet" if draft["captured_via"] == "bookmarklet" else "manual",
                    draft["source_url"] if draft["captured_via"] == "bookmarklet" else None,
                    draft["capture_ean"] if draft["captured_via"] == "bookmarklet" else None,
                    draft["source_retailer_id"],
                )
            await connection.execute(
                "UPDATE v2_price_drafts SET status=$1,reviewed_by=$2,"
                "reviewed_at=now(),updated_at=now() WHERE id=$3",
                "approved" if approve else "rejected", user["id"], draft_id,
            )
        return {"id": draft_id, "status": "approved" if approve else "rejected",
                "observation_id": observation_id}
    except asyncpg.UniqueViolationError as exc:
        raise HTTPException(
            status_code=409, detail="Un relevé identique est déjà publié."
        ) from exc
    finally:
        await connection.close()


@router.post("/drafts/{draft_id}/approve")
async def approve_price_draft(draft_id: int, request: Request):
    return await _review(draft_id, request, approve=True)


@router.post("/drafts/{draft_id}/reject")
async def reject_price_draft(draft_id: int, request: Request):
    return await _review(draft_id, request, approve=False)
