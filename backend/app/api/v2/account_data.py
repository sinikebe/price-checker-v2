"""Authenticated export of a person's V2 account and contributions."""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, SecretStr

from app.api.v2.auth_security import verify_second_factor

from app.api.v2.auth import (
    _COOKIE_NAME,
    _bump_limit,
    _connect,
    _current_user,
    _limit_key,
    _secure_write,
    _session_user,
    _verify_password,
)

router = APIRouter(prefix="/api/v2/account", tags=["v2-account-data"])


class AccountDeletion(BaseModel):
    password: SecretStr
    second_factor: str | None = None

_JSON_FIELDS = {"data", "payload", "steps", "product_ids", "before_data", "after_data", "raw_payload"}


def _rows(rows) -> list[dict]:
    result = []
    for row in rows:
        item = dict(row)
        for key in _JSON_FIELDS & item.keys():
            if isinstance(item[key], str):
                item[key] = json.loads(item[key])
        result.append(item)
    return result


@router.get("/export")
async def export_account_data(request: Request):
    connection = await _connect()
    try:
        user = await _current_user(connection, request)
        if user is None:
            raise HTTPException(status_code=401, detail="Connectez-vous pour exporter vos données.")
        async with connection.transaction(isolation="repeatable_read", readonly=True):
            user_id = user["id"]
            account = await connection.fetchrow(
                "SELECT id, username, role, created_at FROM v2_users WHERE id=$1", user_id
            )
            if account is None:
                raise HTTPException(status_code=401, detail="Session expirée.")
            product_drafts = await connection.fetch(
                "SELECT id, product_id, data, status, revision, change_kind, "
                "created_at, updated_at FROM v2_product_drafts "
                "WHERE author_id=$1 ORDER BY id", user_id
            )
            product_events = await connection.fetch(
                "SELECT id, product_id, event_type, before_data, after_data, created_at "
                "FROM v2_product_events WHERE actor_id=$1 ORDER BY id", user_id
            )
            recipes = await connection.fetch(
                "SELECT id, title, description, base_servings, prep_minutes, "
                "cook_minutes, steps, revision, created_at, updated_at "
                "FROM v2_recipes WHERE author_id=$1 ORDER BY id", user_id
            )
            ingredients = await connection.fetch(
                "SELECT i.* FROM v2_recipe_ingredients i JOIN v2_recipes r "
                "ON r.id=i.recipe_id WHERE r.author_id=$1 ORDER BY i.recipe_id,i.position",
                user_id,
            )
            recipe_submissions = await connection.fetch(
                "SELECT id,recipe_id,payload,base_revision,revision,status,created_at,"
                "reviewed_at,result_recipe_id FROM v2_recipe_submissions "
                "WHERE author_id=$1 ORDER BY id", user_id,
            )
            price_drafts = await connection.fetch(
                "SELECT id, product_id, product_draft_id, capture_ean, retailer_id, store_id, entry_kind, "
                "captured_via, source_url, captured_store_name, price, quantity_text, observed_at, "
                "note, status, revision, created_at, updated_at "
                "FROM v2_price_drafts WHERE author_id=$1 ORDER BY id", user_id
            )
            store_alias_proposals = await connection.fetch(
                "SELECT id,store_id,source,name,status,created_at,reviewed_at "
                "FROM v2_store_alias_proposals WHERE author_id=$1 ORDER BY id", user_id
            )
            published_prices = await connection.fetch(
                "SELECT id, product_id, retailer_id, store_id, source, source_url, "
                "capture_ean, price, observed_at, note, created_at FROM v2_price_observations "
                "WHERE contributor_id=$1 ORDER BY id", user_id
            )
            api_tokens = await connection.fetch(
                "SELECT id,label,scope,created_at,expires_at,last_used_at,revoked_at "
                "FROM v2_api_tokens WHERE user_id=$1 ORDER BY id", user_id
            )
            mfa_enabled = bool(await connection.fetchval(
                "SELECT enabled_at IS NOT NULL FROM v2_mfa_credentials WHERE user_id=$1",
                user_id,
            ))
            reports = await connection.fetch(
                "SELECT id, kind, content_id, reason, status, created_at, reviewed_at "
                "FROM v2_content_reports WHERE reporter_id=$1 ORDER BY id", user_id
            )
        payload = {
            "format": "price-checker-v2-account-export",
            "account": dict(account),
            "product_drafts": _rows(product_drafts),
            "product_events": _rows(product_events),
            "recipes": _rows(recipes),
            "recipe_ingredients": _rows(ingredients),
            "recipe_submissions": _rows(recipe_submissions),
            "price_drafts": _rows(price_drafts),
            "store_alias_proposals": _rows(store_alias_proposals),
            "published_prices": _rows(published_prices),
            "reports": _rows(reports),
            "account_security": {"mfa_enabled": mfa_enabled, "api_tokens": _rows(api_tokens)},
        }
        return JSONResponse(
            content=jsonable_encoder(payload),
            headers={
                "Cache-Control": "no-store",
                "Content-Disposition": 'attachment; filename="price-checker-v2-account.json"',
            },
        )
    finally:
        await connection.close()


@router.delete("", status_code=204)
async def delete_account(
    payload: AccountDeletion, request: Request, response: Response,
):
    _secure_write(request)
    password = payload.password.get_secret_value()
    if not password or len(password.encode("utf-8")) > 1024:
        raise HTTPException(status_code=422, detail="Mot de passe invalide.")
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        if await _bump_limit(
            connection, _limit_key("account-delete", request, str(user["id"])),
            3600,
        ) > 5:
            raise HTTPException(status_code=429, detail="Trop de tentatives. Réessayez plus tard.")
        async with connection.transaction():
            account = await connection.fetchrow(
                "SELECT id, role, password_hash FROM v2_users WHERE id=$1 FOR UPDATE",
                user["id"],
            )
            if account is None:
                raise HTTPException(status_code=401, detail="Session expirée.")
            if account["role"] == "admin":
                raise HTTPException(
                    status_code=409,
                    detail="Le compte administrateur initial ne peut pas être supprimé ici.",
                )
            if not await _verify_password(account["password_hash"], password):
                raise HTTPException(status_code=401, detail="Mot de passe incorrect.")
            if not await verify_second_factor(connection, user["id"], payload.second_factor):
                raise HTTPException(status_code=401, detail="Code de validation incorrect.")
            user_id = account["id"]
            # Keep published recipes and audit history, without an author link.
            # A revision bump invalidates already cached recipe details in the PWA.
            await connection.execute(
                "UPDATE v2_recipes SET author_id=NULL, revision=revision+1, "
                "updated_at=now() WHERE author_id=$1", user_id,
            )
            await connection.execute(
                "UPDATE v2_product_events SET actor_id=NULL WHERE actor_id=$1",
                user_id,
            )
            await connection.execute(
                "UPDATE v2_product_events SET draft_id=NULL WHERE draft_id IN "
                "(SELECT id FROM v2_product_drafts WHERE author_id=$1)", user_id,
            )
            await connection.execute(
                "UPDATE v2_price_observations SET contributor_id=NULL, "
                "price_draft_id=NULL WHERE contributor_id=$1 OR price_draft_id IN "
                "(SELECT id FROM v2_price_drafts WHERE author_id=$1)", user_id,
            )
            await connection.execute(
                "UPDATE v2_offers SET price_draft_id=NULL WHERE price_draft_id IN "
                "(SELECT id FROM v2_price_drafts WHERE author_id=$1)", user_id,
            )
            # Drafts, personal reports, basket and all sessions do not survive.
            await connection.execute(
                "DELETE FROM v2_content_reports WHERE reporter_id=$1", user_id,
            )
            await connection.execute(
                "DELETE FROM v2_store_alias_proposals WHERE author_id=$1", user_id,
            )
            await connection.execute(
                "DELETE FROM v2_product_drafts WHERE author_id=$1", user_id,
            )
            await connection.execute(
                "DELETE FROM v2_price_drafts WHERE author_id=$1", user_id,
            )
            await connection.execute("DELETE FROM v2_users WHERE id=$1", user_id)
        response.delete_cookie(_COOKIE_NAME, path="/api/v2")
    finally:
        await connection.close()
