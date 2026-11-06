"""Credits that pay for seeing prices: the balance of the viewer, the charge, and the amounts.

Prices cost credits wherever they are shown: one per product on a product page, one per product
shown with prices on a group or ensemble page, one per line for a basket. Accounts receive a daily
grant up to a holding limit; visitors without an account have a small daily allowance per network
address; administrators are not counted. The charge happens in the transaction of the reading, so
a refused or failed reading costs nothing.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.api.v2.auth import _check_origin, _connect, _current_user, _limit_key, _require_admin_role, _secure_write
from app.services import v2_basket_credits as credits

router = APIRouter(prefix="/api/v2/credits", tags=["v2-credits"])

BOUNDS = {"daily_grant": (0, 1000), "hold_max": (1, 10000), "visitor_daily": (0, 1000),
          "reward_price": (0, 1000), "reward_product": (0, 1000), "reward_recipe": (0, 1000)}
REWARDS_LISTED = 20


def _visitor_key(request: Request) -> str:
    return _limit_key("price-visitor", request)


async def charge(connection, request: Request, cost: int) -> dict:
    """Spend `cost` credits of whoever reads, inside the caller's transaction; their state after it.

    Raises 429 with the state and the cost when the balance (or a visitor's allowance) is too low.
    A cookie-session request from another site is refused before anything is spent.
    """
    _check_origin(request)
    user = await _current_user(connection, request)
    cfg = await credits.settings(connection)
    now = credits.paris_now()
    if user is not None and user["role"] == "admin":
        return credits.unlimited_state(now.date(), cfg)
    if cost <= 0:
        return await viewer_state(connection, request, user, cfg)
    if user is not None:
        state = await credits.lock_and_refill(connection, user["id"], cfg)
        spent = await credits.spend(connection, user["id"], state, cost)
        if spent is None:
            raise credits.no_credits(credits.public_state(state["balance"], state["today"], cfg, state["bonus"]),
                                     cost, now, "Pas assez de crédits pour afficher ces prix.")
        return credits.public_state(spent["balance"], spent["today"], cfg, spent["bonus"])
    remaining = await credits.visitor_spend(connection, _visitor_key(request), cost, now.date(), cfg["visitor_daily"])
    if remaining is None:
        used = await credits.visitor_used(connection, _visitor_key(request), now.date())
        raise credits.no_credits(credits.visitor_state(max(0, cfg["visitor_daily"] - used), now.date(), cfg),
                                 cost, now, "Consultations du jour épuisées : connectez-vous pour avoir des crédits.")
    return credits.visitor_state(remaining, now.date(), cfg)


async def viewer_state(connection, request: Request, user, cfg: dict) -> dict:
    """The credits of whoever reads, without spending (an account's daily grant is applied)."""
    today = credits.paris_now().date()
    if user is not None and user["role"] == "admin":
        return credits.unlimited_state(today, cfg)
    if user is not None:
        state = await credits.lock_and_refill(connection, user["id"], cfg)
        return credits.public_state(state["balance"], state["today"], cfg, state["bonus"])
    used = await credits.visitor_used(connection, _visitor_key(request), today)
    return credits.visitor_state(max(0, cfg["visitor_daily"] - used), today, cfg)


@router.get("")
async def read_credits(request: Request, response: Response):
    """The credits of the account (after today's grant), or a visitor's views left today."""
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        user = await _current_user(connection, request)
        async with connection.transaction():
            return await viewer_state(connection, request, user, await credits.settings(connection))
    finally:
        await connection.close()


@router.get("/rewards")
async def read_rewards(request: Request, response: Response):
    """The account's latest contribution credits: what was earned, for what kind of contribution, and when."""
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        user = await _current_user(connection, request)
        if user is None:
            raise HTTPException(status_code=401, detail="Connectez-vous.")
        rows = await connection.fetch(
            "SELECT kind,credits,created_at FROM v2_credit_rewards WHERE user_id=$1 "
            "ORDER BY created_at DESC,id DESC LIMIT $2", user["id"], REWARDS_LISTED)
        total = await connection.fetchval(
            "SELECT coalesce(sum(credits),0) FROM v2_credit_rewards WHERE user_id=$1", user["id"])
        return {"rewards": [{"kind": row["kind"], "credits": row["credits"],
                             "created_at": row["created_at"].isoformat()} for row in rows],
                "earned_total": total}
    finally:
        await connection.close()


class CreditSettingsChange(BaseModel):
    daily_grant: int = Field(ge=BOUNDS["daily_grant"][0], le=BOUNDS["daily_grant"][1])
    hold_max: int = Field(ge=BOUNDS["hold_max"][0], le=BOUNDS["hold_max"][1])
    visitor_daily: int = Field(ge=BOUNDS["visitor_daily"][0], le=BOUNDS["visitor_daily"][1])
    reward_price: int = Field(ge=BOUNDS["reward_price"][0], le=BOUNDS["reward_price"][1])
    reward_product: int = Field(ge=BOUNDS["reward_product"][0], le=BOUNDS["reward_product"][1])
    reward_recipe: int = Field(ge=BOUNDS["reward_recipe"][0], le=BOUNDS["reward_recipe"][1])
    expected_revision: int = Field(ge=0)


async def _require_admin_user(connection, request: Request) -> None:
    _require_admin_role(await _current_user(connection, request))


async def _settings(connection) -> dict:
    cfg = await credits.settings(connection)
    return {**cfg, "bounds": {key: {"min": low, "max": high} for key, (low, high) in BOUNDS.items()}}


@router.get("/settings")
async def read_settings(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        await _require_admin_user(connection, request)
        return await _settings(connection)
    finally:
        await connection.close()


@router.put("/settings")
async def change_settings(payload: CreditSettingsChange, request: Request, response: Response):
    _secure_write(request)
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        await _require_admin_user(connection, request)
        updated = await connection.fetchval(
            "UPDATE v2_credit_settings SET daily_grant=$1, hold_max=$2, visitor_daily=$3, reward_price=$4, "
            "reward_product=$5, reward_recipe=$6, revision=revision+1, updated_at=now() "
            "WHERE singleton AND revision=$7 RETURNING revision",
            payload.daily_grant, payload.hold_max, payload.visitor_daily, payload.reward_price,
            payload.reward_product, payload.reward_recipe, payload.expected_revision)
        if updated is None:
            raise HTTPException(status_code=409, detail="Réglages modifiés entre-temps. Rechargez la page.")
        return await _settings(connection)
    finally:
        await connection.close()
