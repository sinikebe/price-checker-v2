"""Atomic, account-scoped limits for public contribution writes."""

from __future__ import annotations

import hashlib

from fastapi import HTTPException

from app.api.v2.auth import _bump_limit

MAX_WRITES_PER_HOUR = 60
MAX_PRODUCT_DRAFTS = 30
MAX_PRICE_DRAFTS = 100
MAX_RECIPES = 100


async def check_write_limit(connection, user: dict) -> None:
    if user["role"] == "admin":
        return
    # All contribution endpoints use one advisory lock, within their write
    # transaction. This serializes concurrent quota checks for one account.
    await connection.execute("SELECT pg_advisory_xact_lock(783216, $1)", user["id"])
    key = hashlib.sha256(f"contribution:{user['id']}".encode()).hexdigest()
    if await _bump_limit(connection, key, 3600) > MAX_WRITES_PER_HOUR:
        raise HTTPException(
            status_code=429, detail="Trop de modifications. Réessayez dans une heure."
        )


async def check_open_limit(
    connection, user: dict, *, table: str, maximum: int
) -> None:
    if user["role"] == "admin":
        return
    if table not in {"v2_product_drafts", "v2_price_drafts", "v2_recipes"}:
        raise ValueError("Unsupported contribution table")
    status = "" if table == "v2_recipes" else " AND status='draft'"
    count = await connection.fetchval(
        f"SELECT count(*) FROM {table} WHERE author_id=$1{status}", user["id"]
    )
    if count >= maximum:
        raise HTTPException(
            status_code=429,
            detail="Limite de contributions en attente atteinte.",
        )
