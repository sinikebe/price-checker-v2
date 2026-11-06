"""Basket prices: one credit per included line. The account's credits are read here too."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Annotated, Literal

import asyncpg
from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field, field_validator

from app.api.v2.auth import _connect, _limit_key, _secure_write, _session_user, per_minute_limit
from app.api.v2.auth_security import account_limit_key
from app.api.v2.catalogue import group_rows, scope_rows
from app.api.v2.credits import viewer_state
from app.api.v2.products import PRODUCT_LINKS, _product
from app.api.v2.selections import Selection, SelectionRef, current_ids, member_counts, selection_rows
from app.core.paris_time import paris_day
from app.db.v2_sql import MAX_BIGINT
from app.services import v2_basket_credits as credits
from app.services import v2_product_references as references
from app.services import v2_logbook as logbook

router = APIRouter(prefix="/api/v2/basket", tags=["v2-basket"])

MAX_ITEMS = 100
MAX_CANDIDATES = 300  # products compared for one group or scope
MAX_PRODUCTS = 600  # distinct products priced by one request
MAX_STORES = 200  # latest price per store and channel, per product
MAX_CHAIN = 32
ADMIN_FETCHES_PER_MINUTE = 60  # administrators have no credit limit, only a sanity cap against a runaway loop
PREVIEWS_PER_MINUTE = 30
PREVIEW_SAMPLE = 20
PREVIEW_GROUPS = 30


def _clean(value: str) -> str:
    value = " ".join(value.split())
    if not value:
        raise ValueError("Valeur vide.")
    return value


class ProductRef(BaseModel):
    kind: Literal["product"]
    id: int = Field(ge=1, le=MAX_BIGINT)


class GroupRef(BaseModel):
    kind: Literal["group"]
    name: str = Field(min_length=1, max_length=100)
    _clean = field_validator("name")(_clean)


class ScopeRef(BaseModel):
    kind: Literal["scope"]
    department: str = Field(min_length=1, max_length=80)
    family: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=80)
    _clean = field_validator("department", "family", "name")(_clean)


BasketRef = Annotated[ProductRef | GroupRef | ScopeRef | SelectionRef, Field(discriminator="kind")]


class BasketPricesRequest(BaseModel):
    items: list[BasketRef] = Field(min_length=1, max_length=MAX_ITEMS)


async def _current_products(connection, product_ids) -> dict[int, asyncpg.Record | None]:
    """The product row each reference currently stands for, by reference: a merge is followed before
    a new version, as on the product page. None when the product is withdrawn or gone, or when its
    chain loops or is longer than MAX_CHAIN.

    One query per step of the longest chain, however many references are asked for.
    """
    pending = {product_id: product_id for product_id in dict.fromkeys(product_ids)}
    seen: dict[int, set[int]] = {product_id: set() for product_id in pending}
    result: dict[int, asyncpg.Record | None] = {}
    for _ in range(MAX_CHAIN):
        for original, current in list(pending.items()):
            if current in seen[original]:
                result[original] = None
                del pending[original]
            else:
                seen[original].add(current)
        if not pending:
            break
        rows = {row["id"]: row for row in await connection.fetch(
            PRODUCT_LINKS + " WHERE p.id=ANY($1::bigint[])", list(set(pending.values())))}
        for original, current in list(pending.items()):
            row = rows.get(current)
            if row is None or row["withdrawn"]:
                result[original] = None
                del pending[original]
                continue
            following = row["merged_to_id"] or row["successor_id"]
            if following:
                pending[original] = following
            else:
                result[original] = row
                del pending[original]
    for original in pending:
        result[original] = None
    return result


async def _current_product(connection, product_id: int):
    """The product row a reference currently stands for, or None when it is withdrawn or gone."""
    return (await _current_products(connection, [product_id]))[product_id]


async def _latest_prices(connection, product_ids: list[int]) -> dict[int, dict]:
    """The latest published price per store and sales channel, for each product."""
    rows = await connection.fetch(
        """
        SELECT * FROM (
            SELECT latest.*, row_number() OVER (
                       PARTITION BY latest.product_id
                       ORDER BY latest.observed_at DESC, latest.id DESC) AS rank
            FROM (
                SELECT DISTINCT ON (o.product_id,o.store_id,o.sales_channel)
                       o.id,o.product_id,o.price,o.observed_at,o.sales_channel,
                       o.source_provider,o.available,o.correction_status,
                       r.name AS retailer,s.name AS store_name,
                       s.id AS store_id,s.city,s.postal_code,s.online
                FROM v2_price_observations o
                JOIN v2_retailers r ON r.id=o.retailer_id
                JOIN v2_stores s ON s.id=o.store_id
                WHERE o.product_id=ANY($1) AND NOT o.superseded AND s.active
                  AND NOT EXISTS (SELECT 1 FROM v2_store_product_status w
                                  WHERE w.product_id=o.product_id AND w.store_id=o.store_id
                                    AND w.sales_channel=o.sales_channel AND o.observed_at<=w.checked_at)
                ORDER BY o.product_id,o.store_id,o.sales_channel,o.observed_at DESC,o.id DESC
            ) latest
        ) ranked WHERE rank<=$2 ORDER BY product_id, rank
        """,
        product_ids, MAX_STORES + 1)
    result = {product_id: {"latest_by_store": [], "stores_truncated": False, "withdrawn_count": 0}
              for product_id in product_ids}
    # Prices left out above: the product is known to be withdrawn there and nothing newer was seen.
    for row in await connection.fetch(
        """SELECT w.product_id, count(*) AS n FROM v2_store_product_status w
           JOIN v2_stores s ON s.id=w.store_id AND s.active
           WHERE w.product_id=ANY($1)
             AND EXISTS (SELECT 1 FROM v2_price_observations o
                         WHERE o.product_id=w.product_id AND o.store_id=w.store_id
                           AND o.sales_channel=w.sales_channel AND NOT o.superseded
                           AND o.observed_at<=w.checked_at)
             AND NOT EXISTS (SELECT 1 FROM v2_price_observations o
                             WHERE o.product_id=w.product_id AND o.store_id=w.store_id
                               AND o.sales_channel=w.sales_channel AND NOT o.superseded
                               AND o.observed_at>w.checked_at)
           GROUP BY w.product_id""", product_ids):
        result[row["product_id"]]["withdrawn_count"] = row["n"]
    for row in rows:
        entry = result[row["product_id"]]
        if len(entry["latest_by_store"]) == MAX_STORES:
            entry["stores_truncated"] = True
            continue
        entry["latest_by_store"].append({
            "id": row["id"], "price": str(row["price"]), "observed_at": paris_day(row["observed_at"]),
            "retailer": row["retailer"], "store_name": row["store_name"],
            "store_id": row["store_id"], "city": row["city"], "postal_code": row["postal_code"],
            "online": row["online"], "sales_channel": row["sales_channel"], "available": row["available"],
            "correction_status": row["correction_status"],
            "source_provider": row["source_provider"],
        })
    return result


async def _gather(connection, items) -> dict:
    products: dict[int, dict] = {}
    lines = []
    resolved = await _current_products(connection, [ref.id for ref in items if ref.kind == "product"])
    for ref in items:
        if ref.kind == "product":
            row = resolved[ref.id]
            rows = [row] if row else []
        elif ref.kind == "group":
            rows = await group_rows(connection, ref.name, MAX_CANDIDATES + 1)
        elif ref.kind == "selection":
            rows = await selection_rows(connection, ref, MAX_CANDIDATES + 1,
                                        await current_ids(connection, ref, _current_products))
        else:
            rows = await scope_rows(connection, ref.department, ref.family, ref.name,
                                    MAX_CANDIDATES + 1)
        truncated = len(rows) > MAX_CANDIDATES
        ids = []
        for row in rows[:MAX_CANDIDATES]:
            if row["id"] not in products:
                if len(products) >= MAX_PRODUCTS:
                    truncated = True
                    break
                data = _product(row)
                products[row["id"]] = {"id": data["id"], "revision": data["revision"],
                                       "data": data["data"]}
            ids.append(row["id"])
        lines.append({"product_ids": ids, "truncated": truncated})
    # A barcode-only product priced in a basket is in use: the cleanup keeps it.
    await references.touch(connection, [ref.id for ref in items if ref.kind == "product"])
    prices = await _latest_prices(connection, list(products)) if products else {}
    return {
        "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "lines": lines,
        "products": {str(key): value for key, value in products.items()},
        "prices": {str(key): value for key, value in prices.items()},
    }


async def paid_gather(
    connection, user: dict, refs: list, *,
    store: Callable[[dict], Awaitable[None]] | None = None, shared: bool = False,
) -> tuple[dict, dict]:
    """The prices of `refs` for one credit each from `user`, and the user's credits after it.

    `store(result)`, when given, saves the result in the transaction that pays for it. A refused or
    failed reading costs nothing: without enough credits, 429 (and today's grant is still kept).
    Administrators are not charged, only capped at a generous rate. Both outcomes are journaled, as
    numbers only; `shared` marks a shared basket's reading.
    """
    cost = len(refs)
    extra = {"shared": True} if shared else {}
    if user["role"] == "admin":
        # The role comes from the server-side session, never from the request.
        await per_minute_limit(connection, account_limit_key("basket-admin", user["id"]), ADMIN_FETCHES_PER_MINUTE)
        async with connection.transaction():
            result = await _gather(connection, refs)
            if store is not None:
                await store(result)
        await logbook.log_event(
            connection, "basket.prices.fetched", items=cost, products=len(result["products"]),
            truncated=any(line["truncated"] for line in result["lines"]), unlimited=True, **extra)
        return result, credits.unlimited_state(credits.paris_now().date(), await credits.settings(connection))
    async with connection.transaction():
        cfg = await credits.settings(connection)
        state = await credits.lock_and_refill(connection, user["id"], cfg)
        result = None
        if state["balance"] + state["bonus"] >= cost:
            result = await _gather(connection, refs)
            state = await credits.spend(connection, user["id"], state, cost)
            if store is not None:
                await store(result)
            await logbook.log_event(
                connection, "basket.prices.fetched", items=cost, products=len(result["products"]),
                truncated=any(line["truncated"] for line in result["lines"]), credits_left=state["balance"], **extra)
    # Outside the transaction, so that the daily grant applied above is kept on a refusal.
    public = credits.account_state(state, cfg)
    if result is None:
        await logbook.log_event(connection, "basket.prices.refused", reason="no_credits")
        raise credits.no_credits(public, cost, state["now"],
                                 f"Il faut {cost} crédit{'s' if cost > 1 else ''} pour ce panier.")
    return result, public


@router.get("/credits")
async def read_credits(request: Request, response: Response):
    """The credits of the signed-in account, after today's grant."""
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        async with connection.transaction():
            return await viewer_state(connection, request, user, await credits.settings(connection))
    finally:
        await connection.close()


@router.post("/prices")
async def fetch_basket_prices(payload: BasketPricesRequest, request: Request, response: Response):
    """The candidates and latest prices of every basket line, for one credit per line.

    A refused or failed request costs nothing: the credit is spent in the
    same transaction as the reading, once it succeeded. Administrators are not
    charged (and are capped at a generous rate).
    """
    _secure_write(request)
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        result, public = await paid_gather(connection, user, payload.items)
        if user["role"] == "admin":
            return {**result, "credits": public}  # nothing was charged: no cost
        return {**result, "credits": public, "cost": len(payload.items)}
    finally:
        await connection.close()


@router.post("/selection")
async def preview_selection(payload: Selection, request: Request, response: Response):
    """What a selection holds, without prices and without credits: how many products, which groups,
    a few of them, and how many products each included part matches on its own (0: a name to fix).

    Example: `{"name": "Jus de fruits bio", "include": [{"family": "Jus de fruits"}], "words": ["bio"]}`.
    """
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        # Open to visitors, like the catalogue, but bounded per client.
        await per_minute_limit(connection, _limit_key("basket-selection-preview", request), PREVIEWS_PER_MINUTE)
        ids = await current_ids(connection, payload, _current_products)
        rows = await selection_rows(connection, payload, MAX_CANDIDATES + 1, ids)
        counts = await member_counts(connection, payload, ids)
        groups: dict[str, dict] = {}
        for row in rows[:MAX_CANDIDATES]:
            entry = groups.setdefault(row["category_name"].casefold(), {"name": row["category_name"], "products": 0})
            entry["products"] += 1
        sample = []
        for row in rows[:PREVIEW_SAMPLE]:
            data = _product(row)["data"]
            sample.append({"id": row["id"], "name": data.get("name") or "", "brand": data.get("brand") or "",
                           "quantity": data.get("quantity") or "", "group": row["category_name"]})
        return {
            "name": payload.name,
            "products": min(len(rows), MAX_CANDIDATES), "truncated": len(rows) > MAX_CANDIDATES,
            "include": [{"index": index, "level": member.level, "products": count}
                        for index, (member, count) in enumerate(zip(payload.include, counts, strict=True))],
            "groups": sorted(groups.values(), key=lambda item: (-item["products"], item["name"].casefold()))[:PREVIEW_GROUPS],
            "sample": sample,
        }
    finally:
        await connection.close()
