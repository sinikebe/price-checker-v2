"""Per-account V2 basket; clients retain and reconcile offline operations."""

import json

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, model_validator

from app.api.v2.auth import _connect, _current_user, _secure_write

router = APIRouter(prefix="/api/v2/basket", tags=["v2-basket"])


class BasketInput(BaseModel):
    product_ids: list[int] = Field(max_length=300)
    revision: int = Field(ge=0)

    @model_validator(mode="after")
    def unique_ids(self):
        if any(value <= 0 for value in self.product_ids):
            raise ValueError("Identifiant produit invalide.")
        if len(set(self.product_ids)) != len(self.product_ids):
            raise ValueError("Un produit ne peut figurer qu'une fois dans le panier.")
        return self


async def _user(connection, request):
    user = await _current_user(connection, request)
    if user is None:
        raise HTTPException(
            status_code=401, detail="Connectez-vous pour synchroniser le panier."
        )
    return user


@router.get("")
async def get_basket(request: Request):
    connection = await _connect()
    try:
        user = await _user(connection, request)
        row = await connection.fetchrow(
            "SELECT product_ids, revision FROM v2_user_baskets WHERE user_id=$1",
            user["id"],
        )
        return {
            "product_ids": json.loads(row["product_ids"]) if row else [],
            "revision": row["revision"] if row else 0,
        }
    finally:
        await connection.close()


@router.put("")
async def put_basket(payload: BasketInput, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        async with connection.transaction():
            if payload.product_ids:
                found = await connection.fetch(
                    "SELECT id FROM v2_products WHERE id=ANY($1::bigint[])",
                    payload.product_ids,
                )
                if {row["id"] for row in found} != set(payload.product_ids):
                    raise HTTPException(status_code=422, detail="Produit introuvable.")
            row = await connection.fetchrow(
                "SELECT revision FROM v2_user_baskets WHERE user_id=$1 FOR UPDATE",
                user["id"],
            )
            if row is None:
                if payload.revision != 0:
                    raise HTTPException(
                        status_code=409, detail="Panier modifié ailleurs."
                    )
                revision = await connection.fetchval(
                    "INSERT INTO v2_user_baskets(user_id,product_ids) "
                    "VALUES($1,$2::jsonb) ON CONFLICT (user_id) DO NOTHING "
                    "RETURNING revision",
                    user["id"],
                    json.dumps(payload.product_ids),
                )
                if revision is None:
                    raise HTTPException(
                        status_code=409, detail="Panier modifié ailleurs."
                    )
            else:
                if row["revision"] != payload.revision:
                    raise HTTPException(
                        status_code=409, detail="Panier modifié ailleurs."
                    )
                revision = await connection.fetchval(
                    "UPDATE v2_user_baskets SET product_ids=$1::jsonb, "
                    "revision=revision+1, updated_at=now() "
                    "WHERE user_id=$2 RETURNING revision",
                    json.dumps(payload.product_ids),
                    user["id"],
                )
        return {"product_ids": payload.product_ids, "revision": revision}
    finally:
        await connection.close()
