"""Published V2 price observations and moderated, product-specific price drafts."""

from __future__ import annotations

import hashlib
from datetime import date, datetime, time
from decimal import Decimal
from typing import Literal
from zoneinfo import ZoneInfo

import asyncpg
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from app.api.v2.auth import _connect, _current_user, _secure_write
from app.services.v2_visibility import require_visible
from app.services.v2_write_limits import (
    MAX_PRICE_DRAFTS,
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
    city: str = Field(min_length=1, max_length=200)
    postal_code: str = Field(default="", max_length=20)
    sales_channel: Literal["in_store", "drive", "delivery"] = "in_store"
    price: Decimal = Field(ge=0, max_digits=10, decimal_places=2)
    observed_at: datetime
    note: str = Field(default="", max_length=1000)

    @field_validator("retailer", "store_name", "city", "postal_code", "note")
    @classmethod
    def strip_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("retailer", "store_name", "city")
    @classmethod
    def require_name(cls, value: str) -> str:
        if not value:
            raise ValueError("L’enseigne, le point de vente et la ville ou zone sont nécessaires.")
        return value

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
        "SELECT EXISTS(SELECT 1 FROM v2_products WHERE predecessor_id=$1)", product_id
    ):
        raise HTTPException(
            status_code=409,
            detail="Cette référence a été remplacée. Relevez le prix sur sa version actuelle.",
        )


def _hash(value: str) -> str:
    return hashlib.sha256(value.casefold().encode("utf-8")).hexdigest()[:32]


async def _retailer_store(
    connection: asyncpg.Connection, payload: PriceDraftCreate
) -> tuple[int, int]:
    retailer_id = await connection.fetchval(
        "SELECT id FROM v2_retailers WHERE lower(name)=lower($1) ORDER BY id LIMIT 1",
        payload.retailer,
    )
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
    store_id = await connection.fetchval(
        "INSERT INTO v2_stores(retailer_id,name,city,postal_code,import_key) "
        "VALUES($1,$2,$3,$4,$5) ON CONFLICT(import_key) DO UPDATE "
        "SET import_key=EXCLUDED.import_key RETURNING id",
        retailer_id, payload.store_name, payload.city or None,
        payload.postal_code or None, import_key,
    )
    return retailer_id, store_id


def _observation(row: asyncpg.Record) -> dict:
    return {
        "id": row["id"],
        "price": str(row["price"]),
        "observed_at": _day(row["observed_at"]),
        "retailer": row["retailer"],
        "retailer_id": row["retailer_id"],
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
        "store_name": row["store_name"],
        "city": row["city"],
        "sales_channel": row["sales_channel"],
        "status": row["status"],
        "note": row["note"],
    }


@router.get("/products/{product_id}")
async def product_prices(product_id: int):
    connection = await _connect()
    try:
        await _product(connection, product_id)
        rows = await connection.fetch(
            """
            WITH ordered AS (
                SELECT o.id,o.retailer_id,o.store_id,o.price,o.observed_at,
                       o.sales_channel,o.source,o.source_provider,o.available,
                       o.correction_status,o.note,
                       (o.observed_at AT TIME ZONE 'Europe/Paris')::date AS observed_day,
                       lag(o.source_provider) OVER series AS previous_provider,
                       lag(o.price) OVER series AS previous_price,
                       lag(o.available) OVER series AS previous_available,
                       lag(o.correction_status) OVER series AS previous_correction
                FROM v2_price_observations o
                WHERE o.product_id=$1 AND NOT o.superseded
                WINDOW series AS (
                    PARTITION BY o.store_id,o.sales_channel
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
                           PARTITION BY store_id,sales_channel
                           ORDER BY observed_at,id
                       ) AS run_number
                FROM ordered
            ), boundaries AS (
                SELECT runs.*,
                       row_number() OVER (
                           PARTITION BY store_id,sales_channel,run_number
                           ORDER BY observed_at,id
                       ) AS first_in_run,
                       row_number() OVER (
                           PARTITION BY store_id,sales_channel,run_number
                           ORDER BY observed_at DESC,id DESC
                       ) AS last_in_run,
                       min(observed_day) OVER (
                           PARTITION BY store_id,sales_channel,run_number
                       ) AS first_day,
                       max(observed_day) OVER (
                           PARTITION BY store_id,sales_channel,run_number
                       ) AS last_day
                FROM runs
            )
            SELECT b.id,b.price,b.observed_at,b.sales_channel,b.source,
                   b.source_provider,b.available,b.correction_status,b.note,
                   r.name AS retailer,r.id AS retailer_id,s.name AS store_name,
                   s.id AS store_id,s.city,s.postal_code
            FROM boundaries b
            JOIN v2_retailers r ON r.id=b.retailer_id
            JOIN v2_stores s ON s.id=b.store_id
            WHERE b.last_in_run=1
               OR (b.first_in_run=1 AND b.first_day<>b.last_day)
            ORDER BY b.observed_at DESC,b.id DESC LIMIT 201
            """,
            product_id,
        )
        # The chart history is capped, but a store with an older last reading
        # must not disappear from the current comparison. Keep channels apart.
        latest_rows = await connection.fetch(
            """
            SELECT * FROM (
                SELECT DISTINCT ON (o.store_id,o.sales_channel)
                       o.id,o.price,o.observed_at,o.sales_channel,o.source,
                       o.source_provider,o.available,o.correction_status,o.note,
                       r.name AS retailer,r.id AS retailer_id,s.name AS store_name,
                       s.id AS store_id,s.city,s.postal_code
                FROM v2_price_observations o
                JOIN v2_retailers r ON r.id=o.retailer_id
                JOIN v2_stores s ON s.id=o.store_id
                WHERE o.product_id=$1 AND NOT o.superseded
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
                   d.sales_channel,d.status,d.note,r.name AS retailer,
                   s.name AS store_name,s.city
            FROM v2_price_drafts d
            JOIN v2_users u ON u.id=d.author_id
            JOIN v2_retailers r ON r.id=d.retailer_id
            JOIN v2_stores s ON s.id=d.store_id
            WHERE d.product_id=$1 AND (d.author_id=$2 OR
                ($3='admin' AND d.status='draft'))
            ORDER BY d.updated_at DESC,d.id DESC LIMIT 100
            """,
            product_id, user["id"], user["role"],
        )
        return [_draft(row) for row in rows]
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
            retailer_id, store_id = await _retailer_store(connection, payload)
            quantity = await connection.fetchval(
                "SELECT NULLIF(data->>'quantity','') FROM v2_products WHERE id=$1",
                product_id,
            )
            draft_id = await connection.fetchval(
                """
                INSERT INTO v2_price_drafts(
                    author_id,product_id,retailer_id,store_id,entry_kind,
                    price,quantity_text,observed_at,note,sales_channel)
                VALUES($1,$2,$3,$4,'manual',$5,$6,$7,$8,$9) RETURNING id
                """,
                user["id"], product_id, retailer_id, store_id, payload.price,
                quantity, payload.observed_at, payload.note or None,
                payload.sales_channel,
            )
        return {"id": draft_id, "status": "draft"}
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
                observation_id = await connection.fetchval(
                    """
                    INSERT INTO v2_price_observations(
                        product_id,retailer_id,store_id,source,contributor_id,
                        price_draft_id,approved_by,approved_at,price,quantity_text,
                        observed_at,note,sales_channel)
                    VALUES($1,$2,$3,'manual',$4,$5,$6,now(),$7,$8,$9,$10,$11)
                    RETURNING id
                    """,
                    draft["product_id"], draft["retailer_id"], draft["store_id"],
                    draft["author_id"], draft_id, user["id"], draft["price"],
                    draft["quantity_text"], draft["observed_at"], draft["note"],
                    draft["sales_channel"],
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
