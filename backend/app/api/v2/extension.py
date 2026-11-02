"""Prices read by the browser extension, in an administrator's own browser, on a retailer's site.

The extension reads a product's price with the person's own session and chosen store, where a server
cannot. These routes tell it which basket products need a reading (`plan`) and record what it read
(`readings`). They are for administrators in a browser session (the app page talks to the extension and
posts its results), never for a token: a price recorded here is public at once, like a connector's.
"""
from __future__ import annotations

import json
import re
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

from app.api.v2.auth import _bump_limit, _connect, _current_user, _secure_write
from app.api.v2.catalogue import CURRENT
from app.services import v2_logbook as logbook

router = APIRouter(prefix="/api/v2/extension", tags=["v2-extension"])

MAX_BIGINT = 2**63 - 1
MAX_PLAN_PRODUCTS = 200
MAX_PLAN_ITEMS = 60
FRESH_DAYS = 7
READINGS_PER_HOUR = 600
CHANNEL = "drive"
# What the extension can read. The retailer name of the store must contain the keyword, so a reading for
# one site can never be filed under another chain's store.
ADAPTERS = {"carrefour": {"keyword": "carrefour", "host": "https://www.carrefour.fr/"}}
Adapter = Literal["carrefour"]


async def _admin(connection, request: Request) -> dict:
    user = await _current_user(connection, request)
    if request.headers.get("authorization") is not None or user is None or user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Accès administrateur requis, depuis le navigateur.")
    return user


def _same_ean(left: str, right: str) -> bool:
    return left.lstrip("0") == right.lstrip("0") != ""


async def _target_store(connection, adapter: str) -> dict | None:
    """The one active store of the chain that already has prices: the extension's store to read for."""
    rows = await connection.fetch(
        """SELECT s.id,s.name,s.city,s.postal_code,r.name AS retailer,
                  (SELECT count(*) FROM v2_price_observations o WHERE o.store_id=s.id AND NOT o.superseded) AS prices
           FROM v2_stores s JOIN v2_retailers r ON r.id=s.retailer_id
           WHERE s.active AND lower(r.name) LIKE '%' || $1 || '%'
             AND NOT EXISTS (SELECT 1 FROM v2_content_merges m WHERE m.kind='store' AND m.from_id=s.id)
           ORDER BY prices DESC, s.id LIMIT 3""", ADAPTERS[adapter]["keyword"])
    rows = [row for row in rows if row["prices"] > 0]
    if len(rows) != 1:
        return None
    return {key: rows[0][key] for key in ("id", "name", "city", "postal_code", "retailer")}


class PlanRequest(BaseModel):
    adapter: Adapter
    product_ids: list[int] = Field(min_length=1, max_length=MAX_PLAN_PRODUCTS)

    @field_validator("product_ids")
    @classmethod
    def bounded(cls, ids: list[int]) -> list[int]:
        if any(not 1 <= value <= MAX_BIGINT for value in ids):
            raise ValueError("Produit invalide.")
        return list(dict.fromkeys(ids))


@router.post("/plan")
async def plan(payload: PlanRequest, request: Request, response: Response):
    """The basket products that have no fresh price at the chain's store, in the order given, and that store."""
    _secure_write(request)
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        await _admin(connection, request)
        store = await _target_store(connection, payload.adapter)
        if store is None:
            return {"store": None, "items": [], "reason": "store_unknown"}
        rows = await connection.fetch(
            f"""SELECT p.id,p.data->>'ean' AS ean,p.data->>'brand' AS brand,p.data->>'name' AS name
                FROM unnest($1::bigint[]) WITH ORDINALITY AS wanted(id,position)
                JOIN v2_products p ON p.id=wanted.id
                WHERE {CURRENT} AND p.data->>'ean' ~ '^([0-9]{{8}}|[0-9]{{12,14}})$'
                  AND NOT EXISTS (SELECT 1 FROM v2_price_observations o
                                  WHERE o.product_id=p.id AND o.store_id=$2 AND o.sales_channel=$3
                                    AND o.observed_at>=now()-($4::int * interval '1 day')
                                    AND NOT o.superseded AND o.merge_duplicate_of_id IS NULL)
                  AND NOT v2_store_product_held(p.id,$2,$3)
                ORDER BY wanted.position LIMIT $5""",
            payload.product_ids, store["id"], CHANNEL, FRESH_DAYS, MAX_PLAN_ITEMS)
        return {"store": store, "reason": None,
                "items": [{"product_id": row["id"], "ean": row["ean"], "brand": row["brand"] or "", "name": row["name"] or ""} for row in rows]}
    finally:
        await connection.close()


class ReadingCreate(BaseModel):
    adapter: Adapter
    store_id: int = Field(ge=1, le=MAX_BIGINT)
    product_id: int = Field(ge=1, le=MAX_BIGINT)
    ean: str = Field(pattern=r"^\d{8,14}$")
    outcome: Literal["price", "not_sold"]
    price: Decimal | None = Field(default=None, gt=0, lt=10000, max_digits=7, decimal_places=2)
    available: bool = True
    source_url: str | None = Field(default=None, max_length=1000)
    title: str | None = Field(default=None, max_length=300)

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str | None) -> str | None:
        value = " ".join(value.split()) if value else None
        return value or None


@router.post("/readings", status_code=201)
async def record_reading(payload: ReadingCreate, request: Request, response: Response):
    """One reading by the extension: a price at the store, or the product is not sold there."""
    _secure_write(request)
    response.headers["Cache-Control"] = "no-store"
    if (payload.outcome == "price") != (payload.price is not None):
        raise HTTPException(status_code=422, detail="Un prix est exigé pour un relevé de prix, et lui seul.")
    host = ADAPTERS[payload.adapter]["host"]
    if payload.source_url is not None and (not payload.source_url.startswith(host) or re.search(r"\s", payload.source_url)):
        raise HTTPException(status_code=422, detail="Adresse de la fiche invalide.")
    connection = await _connect()
    try:
        user = await _admin(connection, request)
        if await _bump_limit(connection, f"extension-readings:{user['id']}", 3600) > READINGS_PER_HOUR:
            raise HTTPException(status_code=429, detail="Trop de relevés par l’extension. Réessayez plus tard.")
        async with connection.transaction():
            store = await connection.fetchrow(
                "SELECT s.id,s.retailer_id,r.name AS retailer FROM v2_stores s JOIN v2_retailers r ON r.id=s.retailer_id "
                "WHERE s.id=$1 AND s.active", payload.store_id)
            if store is None or ADAPTERS[payload.adapter]["keyword"] not in store["retailer"].lower():
                raise HTTPException(status_code=422, detail="Ce magasin n’est pas celui de l’enseigne lue.")
            product = await connection.fetchrow(f"SELECT p.data FROM v2_products p WHERE p.id=$1 AND {CURRENT}", payload.product_id)
            data = (product["data"] if isinstance(product["data"], dict) else json.loads(product["data"])) if product else {}
            ean = data.get("ean", "")
            if product is None or not isinstance(ean, str) or not _same_ean(ean, payload.ean):
                raise HTTPException(status_code=422, detail="Le code-barres ne correspond pas à ce produit.")
            fresh = await connection.fetchval(
                "SELECT EXISTS(SELECT 1 FROM v2_price_observations o WHERE o.product_id=$1 AND o.store_id=$2 AND o.sales_channel=$3 "
                "AND o.observed_at>=now()-($4::int * interval '1 day') AND NOT o.superseded AND o.merge_duplicate_of_id IS NULL)",
                payload.product_id, payload.store_id, CHANNEL, FRESH_DAYS)
            if fresh:
                return {"saved": False, "reason": "fresh"}
            provider = payload.adapter
            if payload.outcome == "not_sold":
                await connection.execute("SELECT v2_mark_store_product_discontinued($1,$2,$3)", payload.product_id, payload.store_id, CHANNEL)
                await logbook.log_event(connection, "connector.reading.finished", connector=provider, product_id=payload.product_id, outcome="not_found")
                return {"saved": False, "reason": "not_sold"}
            await connection.execute("UPDATE v2_stores SET supports_drive=true WHERE id=$1 AND NOT supports_drive", payload.store_id)
            offer_id = await connection.fetchval(
                "INSERT INTO v2_offers(retailer_id,store_id,source_kind,source_provider,channel,external_product_id,title,ean,price_amount,"
                "available,product_url,collected_at) VALUES($1,$2,'connector',$3,'drive',$4,$5,$6,$7,$8,$9,now()) RETURNING id",
                store["retailer_id"], payload.store_id, provider, payload.ean, payload.title or payload.ean, payload.ean,
                payload.price, payload.available, payload.source_url)
            await connection.execute(
                "INSERT INTO v2_offer_product_links(offer_id,product_id,link_type,confidence,verified,note) "
                "VALUES($1,$2,'ean',1,true,'EAN exact lu sur la fiche par l’extension du navigateur')", offer_id, payload.product_id)
            await connection.execute(
                "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,offer_id,source,source_provider,price,available,"
                "observed_at,sales_channel,source_url,capture_ean) VALUES($1,$2,$3,$4,'connector',$5,$6,$7,now(),'drive',$8,$9)",
                payload.product_id, store["retailer_id"], payload.store_id, offer_id, provider, payload.price, payload.available,
                payload.source_url, payload.ean)
            await connection.execute("SELECT v2_clear_store_product_status($1,$2,$3)", payload.product_id, payload.store_id, CHANNEL)
            await logbook.log_event(connection, "connector.reading.finished", connector=provider, product_id=payload.product_id, outcome="complete")
        return {"saved": True, "reason": None}
    finally:
        await connection.close()
