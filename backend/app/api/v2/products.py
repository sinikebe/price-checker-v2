"""Private V2 product proposals and explicitly moderated public catalogue."""

from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator, model_validator

from app.api.v2.auth import _connect, _current_user, _secure_write
from app.core.url_validation import validate_clickable_url
from app.services.barcodes import normalize_barcode
from app.services import v2_basket_credits as credits
from app.services.quantity_parser import parse_measures
from app.services.v2_visibility import require_visible
from app.services.v2_write_limits import (
    MAX_PRODUCT_DRAFTS,
    check_open_limit,
    check_write_limit,
    lock_account_writes,
)

router = APIRouter(prefix="/api/v2/products", tags=["v2-products"])


class OffSource(BaseModel):
    """The Open Food Facts sheet a contributor read, and the few facts copied from it into the product.

    Only identifying facts are copied (name, brand, quantity, barcode). Composition, Nutri-Score and
    NOVA are read from Open Food Facts by the browser when someone asks, never stored here.
    """

    code: str = Field(max_length=14, pattern=r"^[0-9]{8,14}$")
    checked_at: datetime
    fields: list[Literal["name", "brand", "quantity", "ean"]] = Field(min_length=1, max_length=4)

    @field_validator("fields", mode="before")
    @classmethod
    def identifying_facts_only(cls, value):
        # Sheets written before this rule may list other fields: they are no longer copied.
        if isinstance(value, list):
            return [field for field in value if field in {"name", "brand", "quantity", "ean"}]
        return value


class RetailerLink(BaseModel):
    retailer: str = Field(min_length=1, max_length=100)
    url: str = Field(max_length=1000)
    source: Literal["manual", "capture"] = "manual"

    @field_validator("retailer")
    @classmethod
    def clean_retailer(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Le nom de l'enseigne est nécessaire.")
        return value

    @field_validator("url")
    @classmethod
    def check_url(cls, value: str) -> str:
        return validate_clickable_url(value.strip(), "url")


MeasureUnit = Literal["g", "ml", "piece"]
# A pack is measured in at most one amount per unit: grams, millilitres, pieces.
MAX_MEASURES = 3


class ExtraQuantity(BaseModel):
    """Another way to measure one pack, entered by a contributor (e.g. 6 pieces for 750 g)."""

    amount: Decimal = Field(gt=0, lt=Decimal(10) ** 9, max_digits=12, decimal_places=3)
    unit: MeasureUnit

    @model_validator(mode="after")
    def normalise(self):
        # A count of things is a whole number, as the quantity parser requires.
        if self.unit == "piece" and self.amount != self.amount.to_integral_value():
            raise ValueError("Un nombre de pièces est un nombre entier.")
        # Three decimals, like every parsed quantity, so equal amounts compare equal.
        self.amount = self.amount.quantize(Decimal("0.001"))
        return self


class Measure(BaseModel):
    """One amount of a pack in grams, millilitres or pieces (read-only projection)."""

    amount: Decimal
    unit: MeasureUnit
    count_noun: str | None = None


class ProductData(BaseModel):
    name: str = Field(default="", max_length=160)
    brand: str = Field(default="", max_length=100)
    commercial_name: str = Field(default="", max_length=240)
    composition: str = Field(default="", max_length=4000)
    package: str = Field(default="", max_length=160)
    quantity: str = Field(default="", max_length=80)
    ean: str = Field(default="", max_length=14)
    group: str = Field(default="", max_length=100)
    tags: list[str] = Field(default_factory=list, max_length=30)
    retailer_links: list[RetailerLink] = Field(default_factory=list, max_length=30)
    notes: str = Field(default="", max_length=2000)
    nutriscore: str = Field(default="", max_length=1)
    nova: str = Field(default="", max_length=1)
    nutriscore_version: str = Field(default="", max_length=10)
    # A nutrition check is a separate event from fetching the complete OFF sheet.
    nutrition_checked_at: datetime | None = None
    # The first of `measures`: what the quantity text says, or the first extra.
    quantity_amount: Decimal | None = None
    quantity_unit: MeasureUnit | None = None
    quantity_count_noun: str | None = None
    # Other units of the same pack, one per unit, besides the one the text gives.
    extra_quantities: list[ExtraQuantity] = Field(
        default_factory=list, max_length=MAX_MEASURES
    )
    # Every measure of the pack (the text's, the piece count of a multipack,
    # then the extras): a projection, never client-controlled.
    measures: list[Measure] = Field(default_factory=list, max_length=MAX_MEASURES)
    off_source: OffSource | None = None

    @field_validator("group")
    @classmethod
    def clean_group(cls, value: str) -> str:
        return value.strip()

    @field_validator("tags", mode="before")
    @classmethod
    def parse_tags(cls, value):
        # Accept comma-separated tag text as well as lists.
        if isinstance(value, str):
            return value.split(",")
        return value

    @field_validator("tags")
    @classmethod
    def clean_tags(cls, value: list[str]) -> list[str]:
        result = []
        seen = set()
        for tag in value:
            cleaned = tag.strip()
            if len(cleaned) > 100:
                raise ValueError("Une étiquette ne peut dépasser 100 caractères.")
            if cleaned and cleaned.casefold() not in seen:
                result.append(cleaned)
                seen.add(cleaned.casefold())
        return result

    @model_validator(mode="after")
    def derive_and_validate(self):
        retailers = [link.retailer.casefold() for link in self.retailer_links]
        if len(retailers) != len(set(retailers)):
            raise ValueError("Une seule fiche produit est permise par enseigne.")
        from_text = parse_measures(self.quantity)
        extras = self.extra_quantities
        units = [extra.unit for extra in extras]
        if len(set(units)) != len(units):
            raise ValueError("Une seule valeur par unité de mesure.")
        if from_text and from_text[0].unit in units:
            raise ValueError("Cette unité est déjà donnée par la quantité.")
        # The text's own measure first, its derived piece count unless an extra
        # states the pieces, then the extras in the order they were given.
        measures = [
            Measure(amount=item.amount, unit=item.unit, count_noun=item.count_noun)
            for item in from_text
            if item is from_text[0] or item.unit not in units
        ] + [Measure(amount=extra.amount, unit=extra.unit) for extra in extras]
        self.measures = measures
        # These are a projection, never client-controlled values.
        first = measures[0] if measures else None
        self.quantity_amount = first.amount if first else None
        self.quantity_unit = first.unit if first else None
        self.quantity_count_noun = first.count_noun if first else None
        return self


class DraftCreate(BaseModel):
    product_id: int | None = None
    data: ProductData
    change_kind: Literal["correction", "new_version"] = "correction"


class DraftUpdate(BaseModel):
    revision: int
    data: ProductData
    change_kind: Literal["correction", "new_version"] = "correction"


class DraftApproval(BaseModel):
    revision: int = Field(ge=1)


def _decoded(value):
    return json.loads(value) if isinstance(value, str) else value


def _product(row):
    return {
        "id": row["id"],
        "data": ProductData.model_validate(_decoded(row["data"])).model_dump(
            mode="json"
        ),
        "revision": row["revision"],
        "predecessor_id": row["predecessor_id"],
        "updated_at": row["updated_at"].astimezone(ZoneInfo("Europe/Paris")).date().isoformat(),
    }


def _draft(row):
    return {
        "id": row["id"],
        "product_id": row["product_id"],
        "author_id": row["author_id"],
        "author": row.get("author"),
        "data": ProductData.model_validate(_decoded(row["data"])).model_dump(
            mode="json"
        ),
        "base_revision": row["base_revision"],
        "revision": row["revision"],
        "status": row["status"],
        "change_kind": row["change_kind"],
        "updated_at": row["updated_at"],
        "result_product_id": row["result_product_id"],
        "successor_id": row.get("successor_id"),
    }


async def _user(connection, request):
    user = await _current_user(connection, request)
    if user is None:
        raise HTTPException(
            status_code=401, detail="Connectez-vous pour enregistrer un brouillon."
        )
    return user


def _pack_size_changed(before: str, after: str) -> bool:
    """Whether a new quantity text describes another pack than the old one.

    The same amount in the same unit is the same pack however it is written
    ("415 g", "415g", "0,5 L" and "50 cl"). A different amount in the same unit
    is another pack: its earlier prices were for the old size, so it is a new
    version. A different unit, or a text that was not readable before or after,
    is a unit being fixed or added on the same pack, not a new reference.
    """
    if before.strip() == after.strip():
        return False
    old, new = parse_measures(before), parse_measures(after)
    if not old or not new or old[0].unit != new[0].unit:
        return False
    return old[0].amount != new[0].amount


def _validate_publish(data: dict):
    for key, label in (
        ("name", "nom"),
        ("brand", "marque"),
        ("package", "conditionnement"),
        ("quantity", "quantité"),
    ):
        if not data[key].strip():
            raise HTTPException(
                status_code=422, detail=f"Le champ {label} est nécessaire pour publier."
            )
    if data["ean"] and (
        not data["ean"].isascii()
        or not data["ean"].isdigit()
        or len(data["ean"]) not in (8, 12, 13, 14)
    ):
        raise HTTPException(
            status_code=422,
            detail="Le code EAN/GTIN doit contenir 8, 12, 13 ou 14 chiffres.",
        )
    if data["nutriscore"] and data["nutriscore"].upper() not in "ABCDE":
        raise HTTPException(status_code=422, detail="Nutri-Score invalide.")
    if data["nova"] and data["nova"] not in "1234":
        raise HTTPException(status_code=422, detail="Indice NOVA invalide.")
    if data["nutriscore_version"] and not data["nutriscore"]:
        raise HTTPException(
            status_code=422,
            detail="Une version Nutri-Score nécessite une note Nutri-Score.",
        )


@router.get("")
async def list_products():
    connection = await _connect()
    try:
        rows = await connection.fetch(
            "SELECT p.* FROM v2_products p WHERE NOT EXISTS ("
            "SELECT 1 FROM v2_content_withdrawals w "
            "WHERE w.kind='product' AND w.content_id=p.id) "
            "AND NOT EXISTS (SELECT 1 FROM v2_products next WHERE next.predecessor_id=p.id) "
            "AND NOT EXISTS (SELECT 1 FROM v2_content_merges m WHERE m.kind='product' AND m.from_id=p.id) "
            "ORDER BY p.updated_at DESC, p.id DESC"
        )
        return [_product(row) for row in rows]
    finally:
        await connection.close()


@router.get("/by-barcode/{barcode}")
async def product_by_barcode(barcode: str, request: Request):
    """Resolve the current public reference, then the caller's own new draft.

    GTINs with equivalent leading-zero padding are the same identifier. A
    private draft owned by someone else must be indistinguishable from a miss.
    """
    normalized = normalize_barcode(barcode)
    connection = await _connect()
    try:
        product = await connection.fetchrow(
            "SELECT COALESCE(m.to_id,p.id) AS id FROM v2_products p "
            "LEFT JOIN v2_content_merges m ON m.kind='product' AND m.from_id=p.id "
            "WHERE p.data->>'ean' <> '' "
            "AND NOT EXISTS (SELECT 1 FROM v2_content_withdrawals w "
            "WHERE w.kind='product' AND w.content_id=COALESCE(m.to_id,p.id)) "
            "AND lpad(p.data->>'ean',14,'0')=lpad($1,14,'0') "
            "AND NOT EXISTS (SELECT 1 FROM v2_products next "
            "WHERE next.predecessor_id=p.id) "
            "ORDER BY p.updated_at DESC, p.id DESC LIMIT 1",
            normalized,
        )
        if product is not None:
            return {"kind": "product", "id": product["id"]}
        user = await _current_user(connection, request)
        if user is not None:
            draft = await connection.fetchrow(
                "SELECT id FROM v2_product_drafts WHERE author_id=$1 "
                "AND product_id IS NULL AND status='draft' "
                "AND data->>'ean' <> '' "
                "AND lpad(data->>'ean',14,'0')=lpad($2,14,'0') "
                "ORDER BY updated_at DESC, id DESC LIMIT 1",
                user["id"],
                normalized,
            )
            if draft is not None:
                return {"kind": "draft", "id": draft["id"]}
        raise HTTPException(
            status_code=404, detail="Code-barres inconnu du catalogue V2."
        )
    finally:
        await connection.close()


@router.get("/drafts/mine")
async def my_drafts(request: Request):
    connection = await _connect()
    try:
        user = await _user(connection, request)
        rows = await connection.fetch(
            "SELECT * FROM v2_product_drafts WHERE author_id=$1 "
            "AND status IN ('draft','rejected') "
            "ORDER BY updated_at DESC, id DESC LIMIT 100",
            user["id"],
        )
        return [_draft(row) for row in rows]
    finally:
        await connection.close()


@router.get("/drafts/review")
async def review_drafts(
    request: Request,
    limit: int = Query(30, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    connection = await _connect()
    try:
        user = await _user(connection, request)
        if user["role"] != "admin":
            raise HTTPException(status_code=403, detail="Réservé à l'administrateur.")
        rows = await connection.fetch(
            "SELECT d.*, u.username AS author FROM v2_product_drafts d "
            "JOIN v2_users u ON u.id=d.author_id WHERE d.status='draft' "
            "ORDER BY d.updated_at ASC, d.id ASC LIMIT $1 OFFSET $2",
            limit,
            offset,
        )
        return [_draft(row) for row in rows]
    finally:
        await connection.close()


@router.get("/drafts/{draft_id}")
async def get_draft(draft_id: int, request: Request):
    connection = await _connect()
    try:
        user = await _user(connection, request)
        row = await connection.fetchrow(
            "SELECT d.*, (SELECT next.id FROM v2_products next "
            "WHERE next.predecessor_id=d.product_id ORDER BY next.id DESC LIMIT 1) "
            "AS successor_id FROM v2_product_drafts d WHERE d.id=$1",
            draft_id,
        )
        if row is None or (row["author_id"] != user["id"] and user["role"] != "admin"):
            raise HTTPException(status_code=404, detail="Brouillon introuvable.")
        result = _draft(row)
        prices = await connection.fetch(
            "SELECT d.id,d.price,d.status,d.capture_ean,d.quantity_text,d.captured_store_name,"
            "r.name AS retailer,s.name AS store_name "
            "FROM v2_price_drafts d "
            "JOIN v2_retailers r ON r.id=d.retailer_id "
            "JOIN v2_stores s ON s.id=d.store_id "
            "WHERE d.product_draft_id=$1 AND s.active "
            "ORDER BY d.created_at DESC,d.id DESC LIMIT 100",
            draft_id,
        )
        result["linked_prices"] = [
            {"id": price["id"], "price": str(price["price"]),
             "status": price["status"], "capture_ean": price["capture_ean"],
             "quantity_text": price["quantity_text"],
             "captured_store_name": price["captured_store_name"], "retailer": price["retailer"],
             "store_name": price["store_name"]}
            for price in prices
        ]
        return result
    finally:
        await connection.close()


@router.post("/drafts", status_code=201)
async def create_draft(payload: DraftCreate, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        await check_write_limit(connection, user)
        async with connection.transaction():
            await lock_account_writes(connection, user)
            await check_open_limit(
                connection, user, table="v2_product_drafts",
                maximum=MAX_PRODUCT_DRAFTS,
            )
            base_revision = None
            if payload.product_id is not None:
                await require_visible(connection, "product", payload.product_id)
                # Approval locks this row too; check the successor after acquiring it.
                base_revision = await connection.fetchval(
                    "SELECT revision FROM v2_products WHERE id=$1 FOR UPDATE",
                    payload.product_id,
                )
                if base_revision is None:
                    raise HTTPException(status_code=404, detail="Produit introuvable.")
                successor_id = await connection.fetchval(
                    "SELECT id FROM v2_products WHERE predecessor_id=$1 "
                    "ORDER BY id DESC LIMIT 1",
                    payload.product_id,
                )
                if successor_id is not None or await connection.fetchval(
                    "SELECT EXISTS(SELECT 1 FROM v2_content_merges WHERE kind='product' AND from_id=$1)",
                    payload.product_id,
                ):
                    raise HTTPException(
                        status_code=409,
                        detail="Cette référence a été remplacée. Modifiez sa version actuelle.",
                    )
            row = await connection.fetchrow(
                "INSERT INTO v2_product_drafts"
                "(product_id, author_id, data, base_revision, change_kind) "
                "VALUES($1,$2,$3::jsonb,$4,$5) RETURNING *",
                payload.product_id,
                user["id"],
                payload.data.model_dump_json(),
                base_revision,
                payload.change_kind,
            )
            return _draft(row)
    except Exception as exc:
        # The partial unique index prevents parallel duplicate proposals for one
        # author and published product.
        from asyncpg import UniqueViolationError

        if isinstance(exc, UniqueViolationError):
            raise HTTPException(
                status_code=409, detail="Un brouillon existe déjà pour ce produit."
            ) from exc
        raise
    finally:
        await connection.close()


@router.put("/drafts/{draft_id}")
async def update_draft(draft_id: int, payload: DraftUpdate, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        await check_write_limit(connection, user)
        async with connection.transaction():
            await lock_account_writes(connection, user)
            row = await connection.fetchrow(
                "UPDATE v2_product_drafts SET data=$1::jsonb, change_kind=$2, "
                "revision=revision+1, updated_at=now() WHERE id=$3 AND author_id=$4 "
                "AND status='draft' AND revision=$5 "
                "AND NOT EXISTS (SELECT 1 FROM v2_products next "
                "WHERE next.predecessor_id=v2_product_drafts.product_id) "
                "AND NOT EXISTS (SELECT 1 FROM v2_content_merges m "
                "WHERE m.kind='product' AND m.from_id=v2_product_drafts.product_id) RETURNING *",
                payload.data.model_dump_json(),
                payload.change_kind,
                draft_id,
                user["id"],
                payload.revision,
            )
        if row is None:
            raise HTTPException(
                status_code=409,
                detail="Brouillon modifié ailleurs ou déjà validé. Rechargez-le.",
            )
        return _draft(row)
    finally:
        await connection.close()


@router.delete("/drafts/{draft_id}")
async def discard_superseded_draft(draft_id: int, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        deleted = await connection.fetchval(
            "DELETE FROM v2_product_drafts d WHERE d.id=$1 AND d.author_id=$2 "
            "AND (d.status='rejected' OR (d.status='draft' AND EXISTS "
            "(SELECT 1 FROM v2_products next WHERE next.predecessor_id=d.product_id))) "
            "RETURNING d.id",
            draft_id,
            user["id"],
        )
        if deleted is None:
            raise HTTPException(status_code=404, detail="Ancien brouillon introuvable.")
        return {"deleted": True}
    finally:
        await connection.close()


@router.post("/drafts/{draft_id}/reject")
async def reject_draft(draft_id: int, payload: DraftApproval, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        if user["role"] != "admin":
            raise HTTPException(status_code=403, detail="Rejet réservé à l'administrateur.")
        async with connection.transaction():
            row = await connection.fetchrow(
                "UPDATE v2_product_drafts SET status='rejected',rejected_at=now(), "
                "rejected_by=$1 WHERE id=$2 AND status='draft' AND revision=$3 "
                "RETURNING *",
                user["id"], draft_id, payload.revision,
            )
            if row is None:
                raise HTTPException(
                    status_code=409,
                    detail="Ce brouillon a changé depuis votre relecture. Rechargez-le.",
                )
            await connection.execute(
                "UPDATE v2_price_drafts SET status='rejected',reviewed_by=$1,"
                "reviewed_at=now(),updated_at=now() "
                "WHERE product_draft_id=$2 AND status='draft'",
                user["id"], draft_id,
            )
        return _draft(row)
    finally:
        await connection.close()


@router.post("/drafts/{draft_id}/approve")
async def approve_draft(draft_id: int, payload: DraftApproval, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        if user["role"] != "admin":
            raise HTTPException(
                status_code=403, detail="Validation réservée à l'administrateur."
            )
        async with connection.transaction():
            draft = await connection.fetchrow(
                "SELECT * FROM v2_product_drafts WHERE id=$1 FOR UPDATE",
                draft_id,
            )
            if draft is None or draft["status"] != "draft":
                raise HTTPException(status_code=404, detail="Brouillon non disponible.")
            if draft["revision"] != payload.revision:
                raise HTTPException(
                    status_code=409,
                    detail="Ce brouillon a changé depuis votre relecture. Rechargez-le.",
                )
            data = ProductData.model_validate(_decoded(draft["data"])).model_dump(
                mode="json"
            )
            _validate_publish(data)
            before = None
            if draft["product_id"] is not None:
                await require_visible(connection, "product", draft["product_id"])
                if await connection.fetchval(
                    "SELECT EXISTS(SELECT 1 FROM v2_content_merges WHERE kind='product' AND from_id=$1)",
                    draft["product_id"],
                ):
                    raise HTTPException(status_code=409, detail="Ce produit a été fusionné.")
                existing = await connection.fetchrow(
                    "SELECT * FROM v2_products WHERE id=$1 FOR UPDATE",
                    draft["product_id"],
                )
                if existing is None or existing["revision"] != draft["base_revision"]:
                    raise HTTPException(
                        status_code=409,
                        detail="Le produit a changé depuis la création du brouillon.",
                    )
                successor = await connection.fetchval(
                    "SELECT EXISTS(SELECT 1 FROM v2_products WHERE predecessor_id=$1)",
                    draft["product_id"],
                )
                if successor:
                    raise HTTPException(
                        status_code=409,
                        detail="Cette référence possède déjà une version suivante.",
                    )
                before = _decoded(existing["data"])
                # Filling a previously blank composition documents the existing
                # reference; changing an established recipe or pack size creates
                # a new version. Writing the same pack differently, or fixing its
                # unit, stays a correction of the same reference.
                material = (
                    before.get("package", "").strip() != data["package"].strip()
                    or _pack_size_changed(
                        before.get("quantity", ""), data["quantity"]
                    )
                    or bool(before.get("composition", "").strip())
                    and (
                        before["composition"].strip() != data["composition"].strip()
                    )
                )
                if material and draft["change_kind"] != "new_version":
                    raise HTTPException(
                        status_code=422,
                        detail=(
                            "Composition ou format modifié : choisissez "
                            "« Nouvelle version »."
                        ),
                    )
            barcode = data["ean"].strip()
            if barcode:
                # Serialize approvals of the same GTIN, then recheck inside
                # this transaction so two pending proposals cannot publish
                # duplicate current references concurrently.
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(lpad($1,14,'0'),0))",
                    barcode,
                )
                collision = await connection.fetchval(
                    "SELECT p.id FROM v2_products p LEFT JOIN v2_content_merges m "
                    "ON m.kind='product' AND m.from_id=p.id "
                    "WHERE COALESCE(m.to_id,p.id) IS DISTINCT FROM $2 "
                    "AND p.data->>'ean' <> '' "
                    "AND lpad(p.data->>'ean',14,'0')=lpad($1,14,'0') "
                    "AND NOT EXISTS (SELECT 1 FROM v2_products next "
                    "WHERE next.predecessor_id=p.id) "
                    "AND NOT EXISTS (SELECT 1 FROM v2_content_withdrawals w "
                    "WHERE w.kind='product' AND w.content_id=p.id) LIMIT 1",
                    barcode,
                    draft["product_id"],
                )
                if collision is not None:
                    raise HTTPException(
                        status_code=409,
                        detail="Ce code-barres appartient déjà à un produit publié.",
                    )
            if existing_id := draft["product_id"]:
                if draft["change_kind"] == "new_version":
                    product = await connection.fetchrow(
                        "INSERT INTO v2_products(data,predecessor_id) "
                        "VALUES($1::jsonb,$2) RETURNING *",
                        json.dumps(data),
                        existing_id,
                    )
                    event_type = "new_version"
                else:
                    product = await connection.fetchrow(
                        "UPDATE v2_products SET data=$1::jsonb,revision=revision+1,"
                        "updated_at=now() WHERE id=$2 RETURNING *",
                        json.dumps(data),
                        existing_id,
                    )
                    event_type = "correction"
            else:
                product = await connection.fetchrow(
                    "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING *",
                    json.dumps(data),
                )
                event_type = "created"
            await connection.execute(
                "INSERT INTO v2_product_events"
                "(product_id,draft_id,actor_id,event_type,before_data,after_data) "
                "VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)",
                product["id"],
                draft_id,
                user["id"],
                event_type,
                json.dumps(before) if before is not None else None,
                json.dumps(data),
            )
            if event_type == "new_version":
                await connection.execute(
                    "INSERT INTO v2_product_events"
                    "(product_id,draft_id,actor_id,event_type,before_data,after_data) "
                    "VALUES($1,$2,$3,'superseded',$4::jsonb,$5::jsonb)",
                    draft["product_id"],
                    draft_id,
                    user["id"],
                    json.dumps(before),
                    json.dumps(data),
                )
            await connection.execute(
                "UPDATE v2_product_drafts SET status='approved',approved_at=now(),"
                "approved_by=$1,result_product_id=$2,updated_at=now() WHERE id=$3",
                user["id"], product["id"], draft_id,
            )
            await credits.reward(connection, draft["author_id"], "product", draft_id)
            # A linked price remains private and pending after publication of
            # its product; its own reviewer must still approve it separately.
            await connection.execute(
                "UPDATE v2_price_drafts SET product_id=$1,product_draft_id=NULL,"
                "updated_at=now() WHERE product_draft_id=$2 AND status='draft'",
                product["id"], draft_id,
            )
            return _product(product)
    finally:
        await connection.close()


@router.get("/{product_id}/history")
async def product_history(product_id: int):
    connection = await _connect()
    try:
        await require_visible(connection, "product", product_id)
        rows = await connection.fetch(
            "SELECT e.* FROM v2_product_events e WHERE e.product_id=$1 "
            "ORDER BY e.created_at DESC, e.id DESC",
            product_id,
        )
        return [
            {
                "id": row["id"],
                "event_type": row["event_type"],
                "created_at": row["created_at"].astimezone(ZoneInfo("Europe/Paris")).date().isoformat(),
                "before": _decoded(row["before_data"]),
                "after": _decoded(row["after_data"]),
            }
            for row in rows
        ]
    finally:
        await connection.close()


@router.get("/{product_id}")
async def get_product(product_id: int):
    connection = await _connect()
    try:
        await require_visible(connection, "product", product_id)
        row = await connection.fetchrow(
            "SELECT * FROM v2_products WHERE id=$1", product_id
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Produit introuvable.")
        product = _product(row)
        product["merged_to_id"] = await connection.fetchval(
            "SELECT to_id FROM v2_content_merges WHERE kind='product' AND from_id=$1",product_id)
        product["successor_id"] = await connection.fetchval(
            "SELECT id FROM v2_products WHERE predecessor_id=$1 "
            "ORDER BY id DESC LIMIT 1", product_id
        )
        return product
    finally:
        await connection.close()
