"""Atomic, account-scoped limits for public contribution writes."""

from __future__ import annotations

import hashlib

from fastapi import HTTPException

from app.api.v2.auth import _bump_limit
from app.db.v2_locks import ACCOUNT_WRITES

MAX_WRITES_PER_HOUR = 60
MAX_PRODUCT_DRAFTS = 30
MAX_PRICE_DRAFTS = 100
MAX_RECIPES = 100


async def check_write_limit(connection, user: dict) -> None:
    """Count one write attempt for the account. Call it before the write's transaction: the count is
    committed on its own, so a write that then fails and rolls back still counts."""
    if connection.is_in_transaction():
        raise RuntimeError("Count the attempt before the write transaction.")
    if user["role"] == "admin":
        return
    key = hashlib.sha256(f"contribution:{user['id']}".encode()).hexdigest()
    if await _bump_limit(connection, key, 3600) > MAX_WRITES_PER_HOUR:
        raise HTTPException(
            status_code=429, detail="Trop de modifications. Réessayez dans une heure."
        )


async def lock_account_writes(connection, user: dict) -> None:
    """Inside the write transaction: one advisory lock per account serializes concurrent quota checks
    (open drafts, counts) of that account."""
    if user["role"] == "admin":
        return
    await connection.execute(f"SELECT pg_advisory_xact_lock({ACCOUNT_WRITES}, $1)", user["id"])


async def check_open_limit(
    connection, user: dict, *, table: str, maximum: int
) -> None:
    if user["role"] == "admin":
        return
    if table not in {"v2_product_drafts", "v2_price_drafts", "v2_recipes", "v2_recipe_submissions"}:
        raise ValueError("Unsupported contribution table")
    status = ("" if table == "v2_recipes" else " AND status='pending'"
              if table == "v2_recipe_submissions" else " AND status='draft'")
    count = await connection.fetchval(
        f"SELECT count(*) FROM {table} WHERE author_id=$1{status}", user["id"]
    )
    if count >= maximum:
        raise HTTPException(
            status_code=429,
            detail="Limite de contributions en attente atteinte.",
        )
