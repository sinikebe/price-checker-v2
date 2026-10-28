"""Store-name matching and independently moderated aliases.

A captured store label is only a candidate. Exact aliases are trusted after an
administrator approves them; fuzzy names are never silently attached.
"""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher
from typing import Literal

import asyncpg
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator

from app.api.v2.auth import _connect, _current_user, _secure_write
from app.services.v2_write_limits import check_write_limit

router = APIRouter(prefix="/api/v2/stores", tags=["v2-stores"])
AliasSource = Literal["retailer", "open_food_facts", "open_prices"]


def name_key(value: str) -> str:
    folded = unicodedata.normalize("NFKD", value.casefold())
    ascii_text = "".join(char for char in folded if not unicodedata.combining(char))
    return " ".join(re.findall(r"[a-z0-9]+", ascii_text))


def _location_compatible(row, city: str, postal_code: str) -> bool:
    # Legacy incomplete stores stay public for completion, never automatic capture targets.
    if not (row["city"] or "").strip() or not (row["postal_code"] or "").strip():
        return False
    if postal_code and row["postal_code"] and postal_code.strip() != row["postal_code"].strip():
        return False
    return not (city and row["city"] and name_key(city) != name_key(row["city"]))


def _store_dict(row) -> dict:
    return {"id": row["id"], "retailer": row["retailer"], "name": row["name"],
            "city": row["city"], "postal_code": row["postal_code"]}


# Pending user-entered stores are visible only to their author; imported OSM
# locations and stores with an approved observation are public.
VISIBLE = """($2::boolean OR s.osm_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM v2_price_observations o WHERE o.store_id=s.id)
    OR ($3::bigint IS NOT NULL AND EXISTS (
        SELECT 1 FROM v2_price_drafts d WHERE d.store_id=s.id AND d.author_id=$3)))"""


@router.get("/matches")
async def matches(
    request: Request,
    retailer: str = Query(min_length=2, max_length=200),
    name: str = Query(min_length=2, max_length=300),
    city: str = Query("", max_length=200),
    postal_code: str = Query("", max_length=20),
    source: AliasSource = "retailer",
):
    query_key = name_key(name)
    if len(query_key) < 2:
        return {"matches": [], "exact_store_id": None}
    connection = await _connect()
    try:
        user = await _current_user(connection, request)
        rows = await connection.fetch(
            "SELECT s.id,s.name,s.city,s.postal_code,r.name AS retailer "
            "FROM v2_stores s JOIN v2_retailers r ON r.id=s.retailer_id "
            "WHERE lower(r.name)=lower($1) AND " + VISIBLE + " ORDER BY s.id LIMIT 5000",
            retailer.strip(), user is not None and user["role"] == "admin",
            user["id"] if user else None,
        )
        if not rows:
            return {"matches": [], "exact_store_id": None}
        alias_rows = await connection.fetch(
            "SELECT store_id,name,name_key FROM v2_store_aliases "
            "WHERE store_id=ANY($1::bigint[]) AND source=$2",
            [row["id"] for row in rows], source,
        )
        aliases: dict[int, list[tuple[str, str]]] = {}
        for alias in alias_rows:
            aliases.setdefault(alias["store_id"], []).append((alias["name"], alias["name_key"]))
        scored = []
        for row in rows:
            if not _location_compatible(row, city, postal_code):
                continue
            labels = [(row["name"], name_key(row["name"]))] + aliases.get(row["id"], [])
            label, score = max(
                ((label, SequenceMatcher(None, query_key, key).ratio()) for label, key in labels),
                key=lambda item: item[1],
            )
            exact = any(key == query_key for _, key in labels)
            if not exact and score < 0.58:
                continue
            location_bonus = (0.1 if postal_code and row["postal_code"] else 0) + (
                0.05 if city and row["city"] else 0
            )
            scored.append((exact, score + location_bonus, row["id"], row, label))
        scored.sort(key=lambda item: (-item[0], -item[1], item[2]))
        exact_ids = [item[2] for item in scored if item[0]]
        return {
            "matches": [{**_store_dict(row), "match": "exact" if exact else "near",
                         "matched_name": label}
                        for exact, _, _, row, label in scored[:6]],
            "exact_store_id": exact_ids[0] if len(exact_ids) == 1 else None,
        }
    finally:
        await connection.close()


class StoreCompletion(BaseModel):
    city: str = Field(min_length=1, max_length=200)
    postal_code: str = Field(min_length=1, max_length=20)

    @field_validator("city", "postal_code")
    @classmethod
    def nonblank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Ville et code postal nécessaires.")
        return value


@router.put("/{store_id}/completion")
async def complete_store(store_id: int, payload: StoreCompletion, request: Request):
    """An administrator can complete a previously published store in place."""
    _secure_write(request)
    connection = await _connect()
    try:
        await _admin(connection, request)
        async with connection.transaction():
            row = await connection.fetchrow(
                "SELECT id,city,postal_code FROM v2_stores WHERE id=$1 FOR UPDATE", store_id,
            )
            if row is None:
                raise HTTPException(status_code=404, detail="Magasin introuvable.")
            if (row["city"] or "").strip() and (row["postal_code"] or "").strip():
                raise HTTPException(status_code=409, detail="Ce magasin est déjà complet.")
            if ((row["city"] or "").strip() and row["city"].strip() != payload.city
                    or (row["postal_code"] or "").strip()
                    and row["postal_code"].strip() != payload.postal_code):
                raise HTTPException(status_code=409, detail="Les données existantes du magasin ont changé.")
            await connection.execute(
                "UPDATE v2_stores SET city=$1,postal_code=$2 WHERE id=$3",
                payload.city, payload.postal_code, store_id,
            )
        return {"id": store_id, "city": payload.city, "postal_code": payload.postal_code}
    finally:
        await connection.close()


async def visible_store(connection: asyncpg.Connection, store_id: int, user: dict) -> dict:
    row = await connection.fetchrow(
        "SELECT s.id,s.name,s.city,s.postal_code,r.name AS retailer "
        "FROM v2_stores s JOIN v2_retailers r ON r.id=s.retailer_id "
        "WHERE s.id=$1 AND " + VISIBLE,
        store_id, user["role"] == "admin", user["id"],
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Magasin introuvable.")
    return _store_dict(row)


async def propose_alias(
    connection: asyncpg.Connection, *, store_id: int, author_id: int,
    source: AliasSource, name: str,
) -> int | None:
    cleaned = " ".join(name.split())[:300]
    key = name_key(cleaned)
    if len(key) < 2:
        raise HTTPException(status_code=422, detail="Nom de magasin trop court.")
    current = await connection.fetchval("SELECT name FROM v2_stores WHERE id=$1", store_id)
    if current is None:
        raise HTTPException(status_code=404, detail="Magasin introuvable.")
    if name_key(current) == key or await connection.fetchval(
        "SELECT EXISTS(SELECT 1 FROM v2_store_aliases "
        "WHERE store_id=$1 AND source=$2 AND name_key=$3)", store_id, source, key,
    ):
        return None
    pending = await connection.fetchval(
        "SELECT count(*) FROM v2_store_alias_proposals "
        "WHERE author_id=$1 AND status='pending'", author_id,
    )
    if pending >= 100:
        raise HTTPException(status_code=429, detail="Trop de noms de magasin en attente.")
    return await connection.fetchval(
        "INSERT INTO v2_store_alias_proposals(store_id,author_id,source,name,name_key) "
        "VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
        store_id, author_id, source, cleaned, key,
    )


class AliasProposalInput(BaseModel):
    name: str = Field(min_length=2, max_length=300)
    source: AliasSource = "retailer"

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if len(name_key(cleaned)) < 2:
            raise ValueError("Nom de magasin trop court.")
        return cleaned


@router.post("/{store_id}/alias-proposals", status_code=201)
async def create_alias_proposal(store_id: int, payload: AliasProposalInput, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _current_user(connection, request)
        if user is None:
            raise HTTPException(status_code=401, detail="Connectez-vous pour proposer un nom.")
        async with connection.transaction():
            await check_write_limit(connection, user)
            await visible_store(connection, store_id, user)
            proposal_id = await propose_alias(
                connection, store_id=store_id, author_id=user["id"],
                source=payload.source, name=payload.name,
            )
        return {"id": proposal_id, "status": "pending" if proposal_id else "already_known"}
    finally:
        await connection.close()


async def _admin(connection, request: Request) -> dict:
    user = await _current_user(connection, request)
    if user is None or user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Accès administrateur requis.")
    return user


@router.get("/alias-proposals/pending")
async def pending_aliases(request: Request):
    connection = await _connect()
    try:
        await _admin(connection, request)
        rows = await connection.fetch(
            "SELECT p.id,p.store_id,p.name,p.source,p.created_at,u.username AS author,"
            "s.name AS store_name,s.city,s.postal_code,r.name AS retailer "
            "FROM v2_store_alias_proposals p "
            "JOIN v2_stores s ON s.id=p.store_id "
            "JOIN v2_retailers r ON r.id=s.retailer_id "
            "JOIN v2_users u ON u.id=p.author_id WHERE p.status='pending' "
            "ORDER BY p.created_at,p.id LIMIT 100"
        )
        return [dict(row) for row in rows]
    finally:
        await connection.close()


class AliasDecision(BaseModel):
    action: Literal["approve", "reject"]


@router.post("/alias-proposals/{proposal_id}/review")
async def review_alias(proposal_id: int, payload: AliasDecision, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        admin = await _admin(connection, request)
        async with connection.transaction():
            proposal = await connection.fetchrow(
                "SELECT * FROM v2_store_alias_proposals WHERE id=$1 FOR UPDATE", proposal_id,
            )
            if proposal is None or proposal["status"] != "pending":
                raise HTTPException(status_code=409, detail="Proposition déjà examinée.")
            if payload.action == "approve":
                await connection.execute(
                    "INSERT INTO v2_store_aliases(store_id,source,name,name_key,approved_by) "
                    "VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
                    proposal["store_id"], proposal["source"], proposal["name"],
                    proposal["name_key"], admin["id"],
                )
            await connection.execute(
                "UPDATE v2_store_alias_proposals SET status=$1,reviewed_by=$2,"
                "reviewed_at=now() WHERE id=$3",
                "approved" if payload.action == "approve" else "rejected",
                admin["id"], proposal_id,
            )
        return {"id": proposal_id, "status": "approved" if payload.action == "approve" else "rejected"}
    finally:
        await connection.close()
