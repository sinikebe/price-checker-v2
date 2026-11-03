"""Saved shopping lists: a copy of a basket's list an account keeps, on its devices and offline.

Stored on the server with the account until the account deletes the list or the account itself.
The browser names each list (`list_id`, a UUID) and sends whole lists, so a list saved or changed
offline is applied once when the connection is back, however many times it is retried.
"""

from __future__ import annotations

import json
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator, model_validator

from app.api.v2.auth import _bump_limit, _connect, _secure_write, _session_user
from app.api.v2.auth_security import account_limit_key
from app.api.v2.basket import _clean
from app.api.v2.shared_baskets import Line, Quantity

router = APIRouter(prefix="/api/v2/lists", tags=["v2-saved-lists"])

MAX_LISTS = 30
MAX_LINES = 300  # in all the sections of one list
WRITES_PER_MINUTE = 60
Key = Annotated[str, Field(min_length=1, max_length=400)]
Text = Annotated[str, Field(max_length=300)]


class ListLine(BaseModel):
    key: Key
    label: str = Field(min_length=1, max_length=200)
    detail: Text = ""
    packages: int = Field(default=1, ge=1, le=9999)
    cents: int | None = Field(default=None, ge=0, le=100_000_000)
    missing: bool = False
    # What to put back in a basket: the article as the basket names it.
    line: Line | None = None
    quantity: Quantity | None = None


class ListSection(BaseModel):
    retailer: str | None = Field(default=None, max_length=200)
    store: Text = ""
    cents: int = Field(default=0, ge=0, le=1_000_000_000)
    lines: list[ListLine] = Field(max_length=MAX_LINES)


class ListContent(BaseModel):
    source: Literal["basket", "shared"]
    source_name: str | None = Field(default=None, max_length=80)
    store_mode: bool = False
    fetched_at: str | None = Field(default=None, max_length=40)
    sections: list[ListSection] = Field(max_length=100)

    @model_validator(mode="after")
    def bounded(self):
        if sum(len(section.lines) for section in self.sections) > MAX_LINES:
            raise ValueError(f"Une liste compte {MAX_LINES} lignes au plus.")
        return self


class ListName(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    _clean = field_validator("name")(_clean)


class SavedList(ListName):
    content: ListContent
    checked: list[Key] = Field(default_factory=list, max_length=MAX_LINES)


class ListChange(BaseModel):
    """Only the fields sent change."""

    name: str | None = Field(default=None, min_length=1, max_length=80)
    checked: list[Key] | None = Field(default=None, max_length=MAX_LINES)
    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        return _clean(value) if value is not None else None


def _decoded(value):
    return json.loads(value) if isinstance(value, str) else value


def _out(row) -> dict:
    return {"id": str(row["list_id"]), "name": row["name"], "content": _decoded(row["content"]),
            "checked": _decoded(row["checked"]), "revision": row["revision"],
            "created_at": row["created_at"].isoformat(), "updated_at": row["updated_at"].isoformat()}


async def _write_limit(connection, user: dict) -> None:
    if await _bump_limit(connection, account_limit_key("saved-list-write", user["id"]), 60) > WRITES_PER_MINUTE:
        raise HTTPException(status_code=429, detail="Trop de modifications de listes. Réessayez dans une minute.")


@router.get("")
async def my_lists(request: Request, response: Response):
    response.headers["Cache-Control"] = "private, no-store"
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        rows = await connection.fetch(
            "SELECT * FROM v2_saved_lists WHERE user_id=$1 ORDER BY updated_at DESC LIMIT $2",
            user["id"], MAX_LISTS)
        return {"lists": [_out(row) for row in rows], "limits": {"lists": MAX_LISTS, "lines": MAX_LINES}}
    finally:
        await connection.close()


@router.put("/{list_id}")
async def save_list(list_id: UUID, payload: SavedList, request: Request, response: Response):
    """Create the list, or replace it when it exists (the same request sent again changes nothing more)."""
    _secure_write(request)
    response.headers["Cache-Control"] = "private, no-store"
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        async with connection.transaction():
            await connection.execute("SELECT pg_advisory_xact_lock(783218, $1)", user["id"])
            await _write_limit(connection, user)
            exists = await connection.fetchval(
                "SELECT EXISTS(SELECT 1 FROM v2_saved_lists WHERE user_id=$1 AND list_id=$2)", user["id"], list_id)
            if not exists and await connection.fetchval(
                    "SELECT count(*) FROM v2_saved_lists WHERE user_id=$1", user["id"]) >= MAX_LISTS:
                raise HTTPException(status_code=409, detail=f"Vous avez déjà {MAX_LISTS} listes enregistrées : "
                                    "supprimez-en une pour en garder une autre.")
            row = await connection.fetchrow(
                "INSERT INTO v2_saved_lists(user_id,list_id,name,content,checked) VALUES($1,$2,$3,$4::jsonb,$5::jsonb) "
                "ON CONFLICT (user_id,list_id) DO UPDATE SET name=excluded.name,content=excluded.content,"
                "checked=excluded.checked,revision=v2_saved_lists.revision+1,updated_at=now() RETURNING *",
                user["id"], list_id, payload.name, payload.content.model_dump_json(exclude_none=True),
                json.dumps(payload.checked))
        return _out(row)
    finally:
        await connection.close()


@router.patch("/{list_id}")
async def change_list(list_id: UUID, payload: ListChange, request: Request, response: Response):
    _secure_write(request)
    response.headers["Cache-Control"] = "private, no-store"
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        async with connection.transaction():
            await _write_limit(connection, user)
            row = await connection.fetchrow(
                "UPDATE v2_saved_lists SET name=coalesce($3,name),checked=coalesce($4::jsonb,checked),"
                "revision=revision+1,updated_at=now() WHERE user_id=$1 AND list_id=$2 RETURNING *",
                user["id"], list_id, payload.name,
                json.dumps(payload.checked) if payload.checked is not None else None)
        if row is None:
            raise HTTPException(status_code=404, detail="Liste introuvable.")
        return _out(row)
    finally:
        await connection.close()


@router.delete("/{list_id}", status_code=204)
async def delete_list(list_id: UUID, request: Request):
    """Deleted for good. Deleting a list already gone succeeds too (a retry after a lost answer)."""
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        async with connection.transaction():
            await _write_limit(connection, user)
            await connection.execute("DELETE FROM v2_saved_lists WHERE user_id=$1 AND list_id=$2", user["id"], list_id)
        return Response(status_code=204)
    finally:
        await connection.close()
