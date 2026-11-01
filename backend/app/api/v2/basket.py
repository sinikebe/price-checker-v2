"""Basket prices: one request, one credit. The account's credits are read here too."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

from app.api.v2.auth import _bump_limit, _connect, _secure_write, _session_user
from app.api.v2.auth_security import account_limit_key
from app.api.v2.catalogue import MAX_BIGINT, group_rows, scope_rows
from app.api.v2.prices import _day
from app.api.v2.products import _product
from app.services import v2_basket_credits as credits
from app.services import v2_logbook as logbook

router = APIRouter(prefix="/api/v2/basket", tags=["v2-basket"])

MAX_ITEMS = 100
MAX_CANDIDATES = 300  # products compared for one group or scope
MAX_PRODUCTS = 600  # distinct products priced by one request
MAX_STORES = 200  # latest price per store and channel, per product
MAX_CHAIN = 32
ADMIN_FETCHES_PER_MINUTE = 60  # administrators have no credit limit, only a sanity cap against a runaway loop


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


class BasketPricesRequest(BaseModel):
    items: list[Annotated[ProductRef | GroupRef | ScopeRef, Field(discriminator="kind")]] = Field(
        min_length=1, max_length=MAX_ITEMS)


async def _current_product(connection, product_id: int):
    """The product row a reference currently stands for, or None when it is withdrawn or gone."""
    seen: set[int] = set()
    current = product_id
    for _ in range(MAX_CHAIN):
        if current in seen:
            return None
        seen.add(current)
        row = await connection.fetchrow(
            """SELECT p.*,
                      (SELECT to_id FROM v2_content_merges m
                        WHERE m.kind='product' AND m.from_id=p.id) AS merged_to_id,
                      (SELECT n.id FROM v2_products n WHERE n.predecessor_id=p.id
                        ORDER BY n.id DESC LIMIT 1) AS successor_id,
                      EXISTS(SELECT 1 FROM v2_content_withdrawals w
                              WHERE w.kind='product' AND w.content_id=p.id) AS withdrawn
               FROM v2_products p WHERE p.id=$1""",
            current)
        if row is None or row["withdrawn"]:
            return None
        following = row["merged_to_id"] or row["successor_id"]
        if not following:
            return row
        current = following
    return None


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
                       s.id AS store_id,s.city,s.postal_code
                FROM v2_price_observations o
                JOIN v2_retailers r ON r.id=o.retailer_id
                JOIN v2_stores s ON s.id=o.store_id
                WHERE o.product_id=ANY($1) AND NOT o.superseded AND s.active
                ORDER BY o.product_id,o.store_id,o.sales_channel,o.observed_at DESC,o.id DESC
            ) latest
        ) ranked WHERE rank<=$2 ORDER BY product_id, rank
        """,
        product_ids, MAX_STORES + 1)
    result = {product_id: {"latest_by_store": [], "stores_truncated": False}
              for product_id in product_ids}
    for row in rows:
        entry = result[row["product_id"]]
        if len(entry["latest_by_store"]) == MAX_STORES:
            entry["stores_truncated"] = True
            continue
        entry["latest_by_store"].append({
            "id": row["id"], "price": str(row["price"]), "observed_at": _day(row["observed_at"]),
            "retailer": row["retailer"], "store_name": row["store_name"],
            "store_id": row["store_id"], "city": row["city"], "postal_code": row["postal_code"],
            "sales_channel": row["sales_channel"], "available": row["available"],
            "correction_status": row["correction_status"],
            "source_provider": row["source_provider"],
        })
    return result


async def _gather(connection, items) -> dict:
    products: dict[int, dict] = {}
    lines = []
    for ref in items:
        if ref.kind == "product":
            row = await _current_product(connection, ref.id)
            rows = [row] if row else []
        elif ref.kind == "group":
            rows = await group_rows(connection, ref.name, MAX_CANDIDATES + 1)
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
    prices = await _latest_prices(connection, list(products)) if products else {}
    return {
        "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "lines": lines,
        "products": {str(key): value for key, value in products.items()},
        "prices": {str(key): value for key, value in prices.items()},
    }


@router.get("/credits")
async def read_credits(request: Request, response: Response):
    """The credits of the signed-in account, after today's grant."""
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        if user["role"] == "admin":
            return credits.unlimited_state(credits.paris_now().date())
        async with connection.transaction():
            state = await credits.lock_and_refill(connection, user["id"])
        return credits.public_state(state["balance"], state["week_granted"], state["today"])
    finally:
        await connection.close()


@router.post("/prices")
async def fetch_basket_prices(payload: BasketPricesRequest, request: Request, response: Response):
    """The candidates and latest prices of every basket line, for one credit.

    A refused or failed request costs nothing: the credit is spent in the
    same transaction as the reading, once it succeeded. Administrators are not
    charged (and are capped at a generous rate).
    """
    _secure_write(request)
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        if user["role"] == "admin":
            # The role comes from the server-side session, never from the request.
            if await _bump_limit(connection, account_limit_key("basket-admin", user["id"]), 60) > ADMIN_FETCHES_PER_MINUTE:
                raise HTTPException(status_code=429, headers={"Retry-After": "60"},
                                    detail="Trop de requêtes. Réessayez dans un instant.")
            result = await _gather(connection, payload.items)
            await logbook.log_event(
                connection, "basket.prices.fetched", items=len(payload.items), products=len(result["products"]),
                truncated=any(line["truncated"] for line in result["lines"]), unlimited=True)
            return {**result, "credits": credits.unlimited_state(credits.paris_now().date())}
        async with connection.transaction():
            state = await credits.lock_and_refill(connection, user["id"])
            result = None
            if state["balance"] >= 1:
                result = await _gather(connection, payload.items)
                state = await credits.spend_one(connection, user["id"], state)
                await logbook.log_event(
                    connection, "basket.prices.fetched", items=len(payload.items), products=len(result["products"]),
                    truncated=any(line["truncated"] for line in result["lines"]), credits_left=state["balance"])
        public = credits.public_state(state["balance"], state["week_granted"], state["today"])
        if result is None:
            await logbook.log_event(connection, "basket.prices.refused", reason="no_credits")
            wait = credits.seconds_until(
                credits.next_grant_on(state["today"], state["week_granted"]), state["now"])
            raise HTTPException(
                status_code=429, headers={"Retry-After": str(wait)},
                detail={"code": "no_credits", "credits": public,
                        "message": "Plus de crédit pour récupérer les prix du panier."})
        return {**result, "credits": public}
    finally:
        await connection.close()
