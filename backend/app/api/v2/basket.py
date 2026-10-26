"""Read-once legacy server baskets; all new basket writes stay in the browser."""

import json

from fastapi import APIRouter, HTTPException, Request, Response

from app.api.v2.auth import _connect, _current_user, _secure_write

router = APIRouter(prefix="/api/v2/basket", tags=["v2-basket"])


async def _user(connection, request):
    user = await _current_user(connection, request)
    if user is None:
        raise HTTPException(status_code=401, detail="Connectez-vous pour récupérer l'ancien panier.")
    expected = request.headers.get("x-v2-basket-user-id")
    if expected is not None and expected != str(user["id"]):
        raise HTTPException(status_code=409, detail="Le compte a changé.")
    return user


@router.get("/legacy")
async def legacy_basket(request: Request, response: Response):
    response.headers["Cache-Control"] = "private, no-store"
    connection = await _connect()
    try:
        user = await _user(connection, request)
        row = await connection.fetchrow(
            "SELECT product_ids FROM v2_user_baskets WHERE user_id=$1", user["id"]
        )
        return {"product_ids": json.loads(row["product_ids"]) if row else []}
    finally:
        await connection.close()


@router.delete("/legacy", status_code=204)
async def clear_legacy_basket(request: Request, response: Response):
    _secure_write(request)
    response.headers["Cache-Control"] = "private, no-store"
    connection = await _connect()
    try:
        user = await _user(connection, request)
        await connection.execute(
            "DELETE FROM v2_user_baskets WHERE user_id=$1", user["id"]
        )
    finally:
        await connection.close()


@router.get("")
async def obsolete_basket():
    raise HTTPException(status_code=410, detail="Le panier est désormais local à cet appareil.")


@router.put("")
async def obsolete_basket_write(request: Request):
    _secure_write(request)
    raise HTTPException(status_code=410, detail="Le panier est désormais local à cet appareil.")
