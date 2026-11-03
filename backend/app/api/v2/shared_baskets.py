"""Shared baskets: a basket an account shares on purpose, edited live by the accounts it invites.

The personal basket stays on each device. A shared basket is stored on the server until its owner
deletes it or deletes the account. Members join with an invitation link, see each change within a
second through a long-polling read, and can leave at any time; the lines they added stay.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import re
import time
from collections import Counter
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Path, Query, Request, Response
from pydantic import BaseModel, Field, field_validator

from app.api.v2.auth import _bump_limit, _connect, _limit_key, _secure_write, _session_user
from app.api.v2.auth_security import account_limit_key
from app.api.v2.basket import _clean, _current_product
from app.api.v2.catalogue import MAX_BIGINT
from app.api.v2.setup import _access_code

router = APIRouter(prefix="/api/v2/shared-baskets", tags=["v2-shared-baskets"])

MAX_LINES = 100  # as many as one price request takes
MAX_MEMBERS = 20  # the owner included
MAX_OWNED = 10
MAX_JOINED = 30  # memberships of one account, its own baskets included
MAX_OPS = 150
WRITES_PER_MINUTE = 60
JOINS_PER_TEN_MINUTES = 30
WAIT_SECONDS = 25  # under the usual 60 s proxy timeout
WAIT_SLICE = 5  # how often a waiting request checks that its client is still there
MAX_WAITERS = 200
MAX_WAITERS_PER_ACCOUNT = 4
RETRY_SECONDS = 10  # when no live slot is free, the client reads again after this delay
READS_PER_MINUTE = 120  # a live client reads a few times a minute; this only stops a runaway loop
_INVITE = re.compile(r"([1-9][0-9]{0,18})-([A-Za-z0-9_-]{22})")
Id = Annotated[int, Path(ge=1, le=MAX_BIGINT)]


class _Live:
    """Wakes the reads waiting on a basket once a change is committed.

    In memory: the API runs as a single process. A read that misses a wake-up still returns at the
    end of its wait and the client reads again, so a change is never lost, only seen later.
    """

    def __init__(self) -> None:
        self.events: dict[int, asyncio.Event] = {}
        self.waiting: Counter[int] = Counter()
        self.accounts: Counter[int] = Counter()
        self.reads: dict[int, tuple[float, int]] = {}

    def allow_read(self, user_id: int) -> bool:
        """At most READS_PER_MINUTE reads per account and minute, counted in memory."""
        now = time.monotonic()
        if len(self.reads) > 10000:
            self.reads = {key: value for key, value in self.reads.items() if now - value[0] < 60}
        started, count = self.reads.get(user_id, (now, 0))
        if now - started >= 60:
            started, count = now, 0
        self.reads[user_id] = (started, count + 1)
        return count < READS_PER_MINUTE

    def subscribe(self, basket_id: int, user_id: int) -> asyncio.Event | None:
        if sum(self.accounts.values()) >= MAX_WAITERS or self.accounts[user_id] >= MAX_WAITERS_PER_ACCOUNT:
            return None
        self.waiting[basket_id] += 1
        self.accounts[user_id] += 1
        return self.events.setdefault(basket_id, asyncio.Event())

    def unsubscribe(self, basket_id: int, user_id: int) -> None:
        self.accounts[user_id] -= 1
        if self.accounts[user_id] <= 0:
            del self.accounts[user_id]
        self.waiting[basket_id] -= 1
        if self.waiting[basket_id] <= 0:
            del self.waiting[basket_id]
            self.events.pop(basket_id, None)

    def notify(self, basket_id: int) -> None:
        event = self.events.pop(basket_id, None)
        if event is not None:
            event.set()


_live = _Live()


class Quantity(BaseModel):
    amount: str = Field(pattern=r"^\d{1,6}(?:\.\d{1,6})?$")
    unit: Literal["g", "kg", "ml", "cl", "l", "piece", "package"]

    @field_validator("amount")
    @classmethod
    def positive(cls, value: str) -> str:
        if Decimal(value) <= 0:
            raise ValueError("Quantité positive nécessaire.")
        return value


class ProductLine(BaseModel):
    kind: Literal["product"]
    product_id: int = Field(ge=1, le=MAX_BIGINT)


class GroupLine(BaseModel):
    kind: Literal["group"]
    name: str = Field(min_length=1, max_length=100)
    _clean = field_validator("name")(_clean)


class ScopeLine(BaseModel):
    kind: Literal["scope"]
    department: str = Field(min_length=1, max_length=80)
    family: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=80)
    _clean = field_validator("department", "family", "name")(_clean)


Line = Annotated[ProductLine | GroupLine | ScopeLine, Field(discriminator="kind")]


class NewLine(BaseModel):
    line: Line
    quantity: Quantity | None = None
    disabled: bool = False


class AddOp(NewLine):
    op: Literal["add"]


class RemoveOp(BaseModel):
    op: Literal["remove"]
    line: Line


class UpdateOp(BaseModel):
    """Only the fields sent change; a null quantity clears it."""

    op: Literal["update"]
    line: Line
    quantity: Quantity | None = None
    disabled: bool | None = None


StoreKey = Annotated[str, Field(pattern=r"^[1-9][0-9]{0,18}:(?:in_store|drive|delivery)$")]
UnitKey = Annotated[str, Field(min_length=1, max_length=400)]


class Filters(BaseModel):
    """The stores compared, as in the basket page (same field names)."""

    storeIds: list[Annotated[int, Field(ge=1, le=MAX_BIGINT)]] = Field(default_factory=list, max_length=200)  # noqa: N815
    cities: list[Annotated[str, Field(min_length=1, max_length=120)]] = Field(default_factory=list, max_length=100)
    departments: list[Annotated[str, Field(pattern=r"^(?:[0-9]{2,3}|2A|2B)$")]] = Field(
        default_factory=list, max_length=100)


class Settings(BaseModel):
    """What every member sees the same way. A field left out keeps its value."""

    advanced: bool | None = None
    compare: Literal["price", "unit"] | None = None
    filters: Filters | None = None
    stores_off: list[StoreKey] | None = Field(default=None, max_length=50)
    units: dict[UnitKey, Literal["g", "ml", "piece"]] | None = Field(default=None, max_length=MAX_LINES)
    # Articles ticked in the shopping list, so the one shopping sees what the others picked up.
    checked: list[UnitKey] | None = Field(default=None, max_length=MAX_LINES)
    # The basket's list as every member sees it: all articles, split across stores, or one store.
    list_mode: str | None = Field(
        default=None, pattern=r"^(?:all|split|store:[1-9][0-9]{0,18}:(?:in_store|drive|delivery))$")

    def patch(self) -> dict:
        return self.model_dump(mode="json", exclude={"op"}, exclude_none=True)


DEFAULT_SETTINGS = {"advanced": False, "compare": "price",
                    "filters": {"storeIds": [], "cities": [], "departments": []},
                    "stores_off": [], "units": {}, "checked": [], "list_mode": "all"}


class SettingsOp(Settings):
    op: Literal["settings"]


class TickOp(BaseModel):
    """Tick or untick one article of the shopping list: ticks made by several members, or sent late
    from a device that was offline, add up instead of replacing each other."""

    op: Literal["tick"]
    key: UnitKey
    on: bool


class Changes(BaseModel):
    ops: list[Annotated[AddOp | RemoveOp | UpdateOp | SettingsOp | TickOp, Field(discriminator="op")]] = Field(
        min_length=1, max_length=MAX_OPS)


class BasketName(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    _clean = field_validator("name")(_clean)


class NewBasket(BasketName):
    lines: list[NewLine] = Field(default_factory=list, max_length=MAX_LINES)
    settings: Settings | None = None


class Join(BaseModel):
    invite: str = Field(min_length=1, max_length=64)
    confirm: bool = False


def _key(line: ProductLine | GroupLine | ScopeLine) -> str:
    """The same key as the basket in the browser (basketItemKey), so one article is one line."""
    if isinstance(line, ProductLine):
        return f"product:{line.product_id}"
    if isinstance(line, GroupLine):
        return "group:" + line.name.lower()
    return ":".join(("scope", line.department, line.family, line.name)).lower()


def _invite(basket_id: int, version: int) -> str:
    digest = hmac.new(_access_code().encode(), f"shared-basket-invite:{basket_id}:{version}".encode(),
                      hashlib.sha256).digest()
    return f"{basket_id}-" + base64.urlsafe_b64encode(digest[:16]).decode().rstrip("=")


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


def _decoded(value):
    return json.loads(value) if isinstance(value, str) else value


async def _write_limit(connection, user: dict) -> None:
    """Count one write attempt, before the write's transaction: a write that fails and rolls back
    still counts."""
    if connection.is_in_transaction():
        raise RuntimeError("Count the attempt before the write transaction.")
    key = account_limit_key("shared-basket-write", user["id"])
    if await _bump_limit(connection, key, 60) > WRITES_PER_MINUTE:
        raise HTTPException(status_code=429, detail="Trop de modifications du panier partagé. Réessayez dans une minute.")


async def _membership(connection, basket_id: int, user: dict, *, lock: bool = False):
    row = await connection.fetchrow(
        "SELECT b.id,b.name,b.owner_id,b.invite_version,b.revision,b.settings FROM v2_shared_baskets b "
        "JOIN v2_shared_basket_members m ON m.basket_id=b.id AND m.user_id=$2 WHERE b.id=$1"
        + (" FOR UPDATE OF b" if lock else ""), basket_id, user["id"])
    if row is None:
        raise HTTPException(status_code=404, detail="Panier partagé introuvable ou accès retiré.")
    return row


def _owner(basket, user: dict) -> None:
    if basket["owner_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Réservé au créateur du panier partagé.")


async def _state(connection, basket_id: int, user: dict) -> dict:
    basket = await _membership(connection, basket_id, user)
    members = await connection.fetch(
        "SELECT u.id,u.username,m.user_id=$2 AS owner FROM v2_shared_basket_members m "
        "JOIN v2_users u ON u.id=m.user_id WHERE m.basket_id=$1 "
        "ORDER BY m.user_id=$2 DESC,m.joined_at,u.id LIMIT $3",
        basket_id, basket["owner_id"], MAX_MEMBERS)
    lines = await connection.fetch(
        "SELECT l.id,l.kind,l.product_id,l.label,l.department,l.family,l.quantity,l.disabled,"
        "l.created_at,l.added_by=$2 AS mine,u.username AS added_by,p.data AS product_data,"
        "p.revision AS product_revision FROM v2_shared_basket_lines l "
        "LEFT JOIN v2_users u ON u.id=l.added_by "
        "LEFT JOIN v2_products p ON p.id=l.product_id AND NOT EXISTS (SELECT 1 FROM "
        "v2_content_withdrawals w WHERE w.kind='product' AND w.content_id=p.id) "
        "WHERE l.basket_id=$1 ORDER BY l.id LIMIT $3",
        basket_id, user["id"], MAX_LINES)
    owner = next((member["username"] for member in members if member["owner"]), None)
    return {
        "id": basket["id"], "name": basket["name"], "revision": basket["revision"],
        "role": "owner" if basket["owner_id"] == user["id"] else "member", "owner": owner,
        "invite": _invite(basket["id"], basket["invite_version"]),
        "members": [{"id": member["id"], "username": member["username"], "owner": member["owner"]}
                    for member in members],
        "lines": [{
            "id": line["id"], "kind": line["kind"], "label": line["label"], "product_id": line["product_id"],
            "department": line["department"], "family": line["family"],
            "quantity": _decoded(line["quantity"]), "disabled": line["disabled"],
            "added_by": line["added_by"], "mine": bool(line["mine"]),
            "created_at": line["created_at"].isoformat(),
            "product": {"id": line["product_id"], "revision": line["product_revision"],
                        "data": _decoded(line["product_data"])} if line["product_data"] else None,
        } for line in lines],
        "settings": {**DEFAULT_SETTINGS, **(_decoded(basket["settings"]) or {})},
        "limits": {"lines": MAX_LINES, "members": MAX_MEMBERS},
    }


async def _changed(connection, basket_id: int) -> None:
    await connection.execute(
        "UPDATE v2_shared_baskets SET revision=revision+1,updated_at=now() WHERE id=$1", basket_id)


async def _add(connection, basket_id: int, item: NewLine, user: dict) -> bool:
    line = item.line
    product_id = label = department = family = None
    if isinstance(line, ProductLine):
        product = await _current_product(connection, line.product_id)
        if product is None:
            raise HTTPException(status_code=422, detail="Un produit n’est plus disponible dans le catalogue.")
        product_id = product["id"]
        line = ProductLine(kind="product", product_id=product_id)
        data = _decoded(product["data"]) or {}
        label = " ".join(str(part) for part in (data.get("brand"), data.get("name")) if part)[:200].strip() \
            or f"Produit {product_id}"
    elif isinstance(line, GroupLine):
        label = line.name
    else:
        label, department, family = line.name, line.department, line.family
    status = await connection.execute(
        "INSERT INTO v2_shared_basket_lines(basket_id,line_key,kind,product_id,label,department,"
        "family,quantity,disabled,added_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) "
        "ON CONFLICT (basket_id,line_key) DO NOTHING",
        basket_id, _key(line), line.kind, product_id, label, department, family,
        item.quantity.model_dump_json() if item.quantity else None, item.disabled, user["id"])
    return status.endswith(" 1")


async def _check_size(connection, basket_id: int) -> None:
    count = await connection.fetchval(
        "SELECT count(*) FROM v2_shared_basket_lines WHERE basket_id=$1", basket_id)
    if count > MAX_LINES:
        raise HTTPException(status_code=409, detail=f"Un panier partagé compte {MAX_LINES} articles au plus.")


@router.get("")
async def my_shared_baskets(request: Request, response: Response):
    _no_store(response)
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        rows = await connection.fetch(
            "SELECT b.id,b.name,b.owner_id=$1 AS owner,u.username AS owner_name,b.updated_at,"
            "(SELECT count(*) FROM v2_shared_basket_lines l WHERE l.basket_id=b.id)::int AS lines,"
            "(SELECT count(*) FROM v2_shared_basket_members x WHERE x.basket_id=b.id)::int AS members "
            "FROM v2_shared_basket_members m JOIN v2_shared_baskets b ON b.id=m.basket_id "
            "JOIN v2_users u ON u.id=b.owner_id WHERE m.user_id=$1 "
            "ORDER BY b.updated_at DESC,b.id DESC LIMIT $2", user["id"], MAX_JOINED)
        return {"baskets": [{**dict(row), "updated_at": row["updated_at"].isoformat()} for row in rows],
                "limits": {"owned": MAX_OWNED, "joined": MAX_JOINED}}
    finally:
        await connection.close()


@router.post("", status_code=201)
async def create_shared_basket(payload: NewBasket, request: Request, response: Response):
    """Store a copy of the current basket on the server, as a new shared basket."""
    _secure_write(request)
    _no_store(response)
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        await _write_limit(connection, user)
        async with connection.transaction():
            await connection.execute("SELECT pg_advisory_xact_lock(783217, $1)", user["id"])
            owned, joined = await connection.fetchrow(
                "SELECT (SELECT count(*) FROM v2_shared_baskets WHERE owner_id=$1),"
                "(SELECT count(*) FROM v2_shared_basket_members WHERE user_id=$1)", user["id"])
            if owned >= MAX_OWNED:
                raise HTTPException(status_code=409, detail=f"Vous avez déjà {MAX_OWNED} paniers partagés : "
                                    "supprimez-en un pour en créer un autre.")
            if joined >= MAX_JOINED:
                raise HTTPException(status_code=409, detail=f"Vous participez déjà à {MAX_JOINED} paniers partagés.")
            basket_id = await connection.fetchval(
                "INSERT INTO v2_shared_baskets(owner_id,name,settings) VALUES($1,$2,$3::jsonb) RETURNING id",
                user["id"], payload.name, json.dumps(payload.settings.patch() if payload.settings else {}))
            await connection.execute(
                "INSERT INTO v2_shared_basket_members(basket_id,user_id) VALUES($1,$2)", basket_id, user["id"])
            for item in payload.lines:
                await _add(connection, basket_id, item, user)
        return await _state(connection, basket_id, user)
    finally:
        await connection.close()


@router.post("/join")
async def join_shared_basket(payload: Join, request: Request, response: Response):
    """Without confirm, what the invitation opens; with it, the account joins the basket."""
    _secure_write(request)
    _no_store(response)
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        by_address = await _bump_limit(connection, _limit_key("shared-basket-join", request), 600)
        by_account = await _bump_limit(connection, account_limit_key("shared-basket-join", user["id"]), 600)
        if by_address > JOINS_PER_TEN_MINUTES or by_account > JOINS_PER_TEN_MINUTES:
            raise HTTPException(status_code=429, detail="Trop de tentatives. Réessayez dans quelques minutes.")
        invalid = HTTPException(status_code=404, detail="Ce lien d’invitation n’est plus valable : demandez-en un nouveau.")
        match = _INVITE.fullmatch(payload.invite)
        if match is None or int(match.group(1)) > MAX_BIGINT:
            raise invalid
        basket_id = int(match.group(1))
        async with connection.transaction():
            basket = await connection.fetchrow(
                "SELECT b.id,b.name,b.invite_version,u.username AS owner,"
                "(SELECT count(*) FROM v2_shared_basket_lines l WHERE l.basket_id=b.id)::int AS lines,"
                "(SELECT count(*) FROM v2_shared_basket_members m WHERE m.basket_id=b.id)::int AS members,"
                "EXISTS(SELECT 1 FROM v2_shared_basket_members m WHERE m.basket_id=b.id AND m.user_id=$2) "
                "AS member FROM v2_shared_baskets b JOIN v2_users u ON u.id=b.owner_id WHERE b.id=$1"
                + (" FOR UPDATE OF b" if payload.confirm else ""), basket_id, user["id"])
            if basket is None or not hmac.compare_digest(_invite(basket_id, basket["invite_version"]), payload.invite):
                raise invalid
            summary = {"id": basket_id, "name": basket["name"], "owner": basket["owner"],
                       "lines": basket["lines"], "members": basket["members"], "member": basket["member"]}
            if not payload.confirm or basket["member"]:
                return summary
            if basket["members"] >= MAX_MEMBERS:
                raise HTTPException(status_code=409, detail=f"Ce panier partagé a déjà {MAX_MEMBERS} membres.")
            await connection.execute("SELECT pg_advisory_xact_lock(783217, $1)", user["id"])
            joined = await connection.fetchval(
                "SELECT count(*) FROM v2_shared_basket_members WHERE user_id=$1", user["id"])
            if joined >= MAX_JOINED:
                raise HTTPException(status_code=409, detail=f"Vous participez déjà à {MAX_JOINED} paniers partagés.")
            await connection.execute(
                "INSERT INTO v2_shared_basket_members(basket_id,user_id) VALUES($1,$2)", basket_id, user["id"])
            await _changed(connection, basket_id)
        _live.notify(basket_id)
        return {**summary, "member": True, "members": basket["members"] + 1}
    finally:
        await connection.close()


@router.get("/{basket_id}")
async def read_shared_basket(
    basket_id: Id, request: Request, response: Response,
    after: int | None = Query(default=None, ge=0, le=MAX_BIGINT), wait: bool = False,
):
    """The basket. With `after` (the revision the client has) and `wait`, the answer waits up to
    25 s for a change: 204 means nothing changed, read again."""
    _no_store(response)
    unchanged = Response(status_code=204, headers={"Cache-Control": "private, no-store"})
    connection = await _connect()
    event = None
    try:
        user = await _session_user(connection, request)
        if not _live.allow_read(user["id"]):
            raise HTTPException(status_code=429, detail="Trop de lectures du panier partagé.",
                                headers={"Retry-After": str(RETRY_SECONDS)})
        basket = await _membership(connection, basket_id, user)
        if after is None or basket["revision"] != after:
            return await _state(connection, basket_id, user)
        if wait:
            # Subscribe before reading the revision again, so a change in between still wakes us.
            event = _live.subscribe(basket_id, user["id"])
        if event is None:
            unchanged.headers["Retry-After"] = str(RETRY_SECONDS)
            return unchanged
        try:
            revision = await connection.fetchval("SELECT revision FROM v2_shared_baskets WHERE id=$1", basket_id)
        except BaseException:
            _live.unsubscribe(basket_id, user["id"])
            raise
        if revision != after:
            _live.unsubscribe(basket_id, user["id"])
            event = None
            return await _state(connection, basket_id, user)
    finally:
        await connection.close()
    # No database connection is held while waiting.
    changed = False
    try:
        for _ in range(WAIT_SECONDS // WAIT_SLICE):
            try:
                await asyncio.wait_for(event.wait(), WAIT_SLICE)
                changed = True
                break
            except TimeoutError:
                if await request.is_disconnected():
                    return unchanged
    finally:
        _live.unsubscribe(basket_id, user["id"])
    if not changed:
        return unchanged
    connection = await _connect()
    try:
        # Read with the session again: the member may have been removed meanwhile.
        user = await _session_user(connection, request)
        return await _state(connection, basket_id, user)
    finally:
        await connection.close()


@router.post("/{basket_id}/changes")
async def change_shared_basket(basket_id: Id, payload: Changes, request: Request, response: Response):
    """Apply a member's changes in order. A line is named by what it is (product, group or scope), as
    in the browser basket, so a change made before an addition was confirmed, or after another member
    changed the basket, still applies to the right line. An article is added once. A settings change
    replaces the settings it names (filters, quantities, price or unit price, stores off, units); a
    tick adds or removes one article of the shopping list's ticks."""
    _secure_write(request)
    _no_store(response)
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        await _write_limit(connection, user)
        async with connection.transaction():
            await _membership(connection, basket_id, user, lock=True)
            changed = False
            for op in payload.ops:
                if isinstance(op, AddOp):
                    changed = await _add(connection, basket_id, op, user) or changed
                elif isinstance(op, SettingsOp):
                    patch = json.dumps(op.patch())
                    status = await connection.execute(
                        "UPDATE v2_shared_baskets SET settings=settings||$2::jsonb "
                        "WHERE id=$1 AND settings IS DISTINCT FROM settings||$2::jsonb", basket_id, patch)
                    changed = status.endswith(" 1") or changed
                elif isinstance(op, TickOp):
                    ticked = "coalesce(settings->'checked','[]'::jsonb)"
                    status = await connection.execute(
                        f"UPDATE v2_shared_baskets SET settings=jsonb_set(settings,'{{checked}}',{ticked}||to_jsonb($2::text)) "
                        f"WHERE id=$1 AND NOT {ticked} ? $2 AND jsonb_array_length({ticked}) < $3"
                        if op.on else
                        f"UPDATE v2_shared_baskets SET settings=jsonb_set(settings,'{{checked}}',{ticked}-$2::text) "
                        f"WHERE id=$1 AND {ticked} ? $2", basket_id, op.key, *([MAX_LINES] if op.on else []))
                    changed = status.endswith(" 1") or changed
                elif isinstance(op, RemoveOp):
                    status = await connection.execute(
                        "DELETE FROM v2_shared_basket_lines WHERE basket_id=$1 AND line_key=$2",
                        basket_id, _key(op.line))
                    changed = status.endswith(" 1") or changed
                else:
                    fields = op.model_fields_set
                    status = await connection.execute(
                        "UPDATE v2_shared_basket_lines SET "
                        "quantity=CASE WHEN $3 THEN $4::jsonb ELSE quantity END,"
                        "disabled=coalesce($5,disabled),updated_at=now() WHERE basket_id=$1 AND line_key=$2",
                        basket_id, _key(op.line), "quantity" in fields,
                        op.quantity.model_dump_json() if op.quantity else None,
                        op.disabled if "disabled" in fields else None)
                    changed = status.endswith(" 1") or changed
            if changed:
                await _check_size(connection, basket_id)
                await _changed(connection, basket_id)
        if changed:
            _live.notify(basket_id)
        return await _state(connection, basket_id, user)
    finally:
        await connection.close()


@router.patch("/{basket_id}")
async def rename_shared_basket(basket_id: Id, payload: BasketName, request: Request, response: Response):
    _secure_write(request)
    _no_store(response)
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        await _write_limit(connection, user)
        async with connection.transaction():
            _owner(await _membership(connection, basket_id, user, lock=True), user)
            await connection.execute("UPDATE v2_shared_baskets SET name=$2 WHERE id=$1", basket_id, payload.name)
            await _changed(connection, basket_id)
        _live.notify(basket_id)
        return await _state(connection, basket_id, user)
    finally:
        await connection.close()


@router.post("/{basket_id}/invite")
async def renew_invite(basket_id: Id, request: Request, response: Response):
    """A new invitation link; the previous one stops working. Members stay."""
    _secure_write(request)
    _no_store(response)
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        await _write_limit(connection, user)
        async with connection.transaction():
            _owner(await _membership(connection, basket_id, user, lock=True), user)
            await connection.execute(
                "UPDATE v2_shared_baskets SET invite_version=invite_version+1 WHERE id=$1", basket_id)
            await _changed(connection, basket_id)
        _live.notify(basket_id)
        return await _state(connection, basket_id, user)
    finally:
        await connection.close()


@router.delete("/{basket_id}/members/{user_id}", status_code=204)
async def remove_member(basket_id: Id, user_id: Id, request: Request):
    """A member leaves (their own id), or the owner removes a member. Their lines stay. A removal by the
    owner also renews the invitation link, so the removed member cannot join again with the old one."""
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        await _write_limit(connection, user)
        async with connection.transaction():
            basket = await _membership(connection, basket_id, user, lock=True)
            if user_id != user["id"]:
                _owner(basket, user)
            if user_id == basket["owner_id"]:
                raise HTTPException(status_code=409, detail="Le créateur ne quitte pas son panier partagé : il peut le supprimer.")
            removed = await connection.fetchval(
                "DELETE FROM v2_shared_basket_members WHERE basket_id=$1 AND user_id=$2 RETURNING user_id",
                basket_id, user_id)
            if removed is None:
                raise HTTPException(status_code=404, detail="Membre introuvable.")
            if user_id != user["id"]:
                # Removed by the owner: the link they know stops working, so they cannot come back.
                await connection.execute(
                    "UPDATE v2_shared_baskets SET invite_version=invite_version+1 WHERE id=$1", basket_id)
            await _changed(connection, basket_id)
        _live.notify(basket_id)
        return Response(status_code=204)
    finally:
        await connection.close()


@router.delete("/{basket_id}", status_code=204)
async def delete_shared_basket(basket_id: Id, request: Request):
    """Deleted for every member, with its lines. It cannot be undone."""
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        async with connection.transaction():
            _owner(await _membership(connection, basket_id, user, lock=True), user)
            await connection.execute("DELETE FROM v2_shared_baskets WHERE id=$1", basket_id)
        _live.notify(basket_id)
        return Response(status_code=204)
    finally:
        await connection.close()
