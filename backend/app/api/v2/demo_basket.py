"""The demo basket of the home page: a basket an administrator saved, with the prices read when it was saved.

Anyone can open it and try every setting of the basket on those prices, without an account or a credit:
the browser computes everything from the stored result, as it does for a basket's own prices. The prices
are read by the server when the basket is saved, never taken from the browser. Without a saved demo,
the app shows its own fictional example.
"""

from __future__ import annotations

import hashlib
import json

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

from app.api.v2.auth import _bump_limit, _connect, _limit_key, _secure_write, _session_user
from app.api.v2.auth_security import account_limit_key
from app.api.v2.basket import GroupRef, ProductRef, ScopeRef, _clean, _gather
from app.api.v2.shared_baskets import DEFAULT_SETTINGS, NewLine, Settings
from app.services import v2_logbook as logbook

router = APIRouter(prefix="/api/v2/demo-basket", tags=["v2-demo-basket"])

MAX_LINES = 100  # as many as one price request takes
MAX_STORED_BYTES = 2_000_000  # what every visitor of the demo downloads
READS_PER_MINUTE = 60  # a page reads it once; this only stops a runaway loop
SAVES_PER_MINUTE = 10


class DemoBasket(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    lines: list[NewLine] = Field(min_length=1, max_length=MAX_LINES)
    settings: Settings = Field(default_factory=Settings)
    _clean = field_validator("title")(_clean)


async def _admin(connection, request: Request) -> dict:
    user = await _session_user(connection, request)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Accès administrateur requis.")
    if await _bump_limit(connection, account_limit_key("demo-basket-save", user["id"]), 60) > SAVES_PER_MINUTE:
        raise HTTPException(status_code=429, headers={"Retry-After": "60"},
                            detail="Trop d’enregistrements. Réessayez dans une minute.")
    return user


def _refs(lines: list[NewLine]):
    for entry in lines:
        line = entry.line
        if line.kind == "product":
            yield ProductRef(kind="product", id=line.product_id)
        elif line.kind == "group":
            yield GroupRef(kind="group", name=line.name)
        else:
            yield ScopeRef(kind="scope", department=line.department, family=line.family, name=line.name)


def _items(lines: list[NewLine], refs: list, result: dict) -> list[dict]:
    """The basket items as the app keeps them, a product with its current catalogue data."""
    items, keys = [], set()
    for entry, ref, gathered in zip(lines, refs, result["lines"], strict=True):
        if ref.kind == "product":
            if not gathered["product_ids"]:
                raise HTTPException(status_code=422, detail="Un produit de ce panier n’est plus au catalogue : "
                                                            "retirez-le, puis réessayez.")
            product = result["products"][str(gathered["product_ids"][0])]
            item, key = {"id": product["id"], "revision": product["revision"], "data": product["data"]}, ("product", product["id"])
        elif ref.kind == "group":
            item, key = {"kind": "group", "name": ref.name}, ("group", ref.name.casefold())
        else:
            item = {"kind": "scope", "department": ref.department, "family": ref.family, "name": ref.name}
            key = ("scope", ref.department.casefold(), ref.family.casefold(), ref.name.casefold())
        if key in keys:
            raise HTTPException(status_code=422, detail="Deux articles de ce panier désignent le même produit ou le même groupe.")
        keys.add(key)
        if entry.disabled:
            item["disabled"] = True
        if entry.quantity:
            item["quantity"] = entry.quantity.model_dump()
        items.append(item)
    return items


@router.get("")
async def read_demo_basket(request: Request):
    """The saved demo basket (`demo` is null without one): articles, settings and the prices read when saved."""
    connection = await _connect()
    try:
        if await _bump_limit(connection, _limit_key("demo-basket-read", request), 60) > READS_PER_MINUTE:
            raise HTTPException(status_code=429, headers={"Retry-After": "60"},
                                detail="Trop de requêtes. Réessayez dans un instant.")
        row = await connection.fetchrow(
            "SELECT title, content::text AS content, saved_at FROM v2_demo_basket WHERE id = 1")
    finally:
        await connection.close()
    headers = {"Cache-Control": "no-cache"}
    if row is None:
        return Response('{"demo":null}', media_type="application/json", headers=headers)
    saved_at = row["saved_at"].isoformat()
    headers["ETag"] = '"' + hashlib.sha256(f"{saved_at}:{row['title']}".encode()).hexdigest()[:32] + '"'
    if request.headers.get("if-none-match") == headers["ETag"]:
        return Response(status_code=304, headers=headers)
    # The content is stored as JSON already: it is sent as it is, not parsed again.
    head = json.dumps({"title": row["title"], "saved_at": saved_at}, ensure_ascii=False)[:-1]
    return Response('{"demo":' + head + ',"content":' + row["content"] + "}}", media_type="application/json", headers=headers)


@router.put("")
async def save_demo_basket(payload: DemoBasket, request: Request, response: Response):
    """Replace the demo basket with this basket: the server reads the current prices of its articles."""
    _secure_write(request)
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        await _admin(connection, request)
        refs = list(_refs(payload.lines))
        result = await _gather(connection, refs)
        items = _items(payload.lines, refs, result)
        # Ticks of the shopping list are the visitor's own: the demo starts with none.
        settings = {**DEFAULT_SETTINGS, **payload.settings.patch(), "checked": []}
        content = json.dumps({"items": items, "settings": settings, "result": result},
                             ensure_ascii=False, separators=(",", ":"))
        if len(content.encode()) > MAX_STORED_BYTES:
            raise HTTPException(status_code=422, detail="Ce panier a trop de prix pour servir d’exemple : "
                                                        "retirez des articles ou des groupes très larges.")
        saved_at = await connection.fetchval(
            "INSERT INTO v2_demo_basket(id, title, content, saved_at) VALUES (1, $1, $2::jsonb, now()) "
            "ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, saved_at = now() "
            "RETURNING saved_at", payload.title, content)
        await logbook.log_event(connection, "basket.demo.saved", items=len(items), products=len(result["products"]))
        return {"title": payload.title, "saved_at": saved_at.isoformat(), "items": len(items),
                "products": len(result["products"])}
    finally:
        await connection.close()


@router.delete("", status_code=204)
async def remove_demo_basket(request: Request):
    """Back to the app's own example."""
    _secure_write(request)
    connection = await _connect()
    try:
        await _admin(connection, request)
        if await connection.fetchval("DELETE FROM v2_demo_basket WHERE id = 1 RETURNING 1"):
            await logbook.log_event(connection, "basket.demo.removed")
    finally:
        await connection.close()
    return Response(status_code=204, headers={"Cache-Control": "no-store"})
