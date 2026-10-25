"""Private V2 product proposals and explicitly moderated public catalogue."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator, model_validator

from app.api.v2.auth import _connect, _current_user, _secure_write
from app.api.v2.off import (
    get_openfoodfacts_product,
    normalize_barcode,
    search_openfoodfacts,
)
from app.core.url_validation import validate_clickable_url
from app.services.off_presenter import build_sections
from app.services.off_rate_limit import OffRateLimited, retry_after_headers
from app.services.quantity_parser import parse_quantity
from app.services.v2_off_snapshot import (
    OFF_PRODUCT_PAGE,
    OffUnavailable,
    _as_int,
    fetch_full_off_product,
)

router = APIRouter(prefix="/api/v2/products", tags=["v2-products"])


class OffSource(BaseModel):
    code: str = Field(max_length=14, pattern=r"^[0-9]{8,14}$")
    checked_at: datetime
    fields: list[
        Literal[
            "name",
            "brand",
            "composition",
            "quantity",
            "ean",
            "nutriscore",
            "nova",
        ]
    ] = Field(min_length=1, max_length=7)


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
    quantity_amount: Decimal | None = None
    quantity_unit: Literal["g", "ml", "piece"] | None = None
    quantity_count_noun: str | None = None
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
        parsed = parse_quantity(self.quantity)
        # These are a projection, never client-controlled values.
        self.quantity_amount = parsed.amount if parsed else None
        self.quantity_unit = parsed.unit if parsed else None
        self.quantity_count_noun = parsed.count_noun if parsed else None
        return self


class DraftCreate(BaseModel):
    product_id: int | None = None
    data: ProductData
    change_kind: Literal["correction", "new_version"] = "correction"


class DraftUpdate(BaseModel):
    revision: int
    data: ProductData
    change_kind: Literal["correction", "new_version"] = "correction"


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
        "updated_at": row["updated_at"],
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
        not data["ean"].isdigit() or len(data["ean"]) not in (8, 12, 13, 14)
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


@router.get("/off/search")
async def search_off(q: str = Query(..., min_length=2, max_length=100)):
    # Use the shared OFF client, cache, normalisation and rate limits.
    return await search_openfoodfacts(q=q, page_size=10)


@router.get("/off/product/{barcode}")
async def lookup_off(barcode: str):
    return await get_openfoodfacts_product(barcode)


@router.get("")
async def list_products():
    connection = await _connect()
    try:
        rows = await connection.fetch(
            "SELECT p.* FROM v2_products p WHERE NOT EXISTS ("
            "SELECT 1 FROM v2_products next WHERE next.predecessor_id=p.id) "
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
            "SELECT p.id FROM v2_products p WHERE p.data->>'ean' <> '' "
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
            "SELECT * FROM v2_product_drafts WHERE author_id=$1 AND status='draft' "
            "ORDER BY updated_at DESC, id DESC",
            user["id"],
        )
        return [_draft(row) for row in rows]
    finally:
        await connection.close()


@router.get("/drafts/review")
async def review_drafts(request: Request):
    connection = await _connect()
    try:
        user = await _user(connection, request)
        if user["role"] != "admin":
            raise HTTPException(status_code=403, detail="Réservé à l'administrateur.")
        rows = await connection.fetch(
            "SELECT d.*, u.username AS author FROM v2_product_drafts d "
            "JOIN v2_users u ON u.id=d.author_id WHERE d.status='draft' "
            "ORDER BY d.updated_at ASC, d.id ASC"
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
        return _draft(row)
    finally:
        await connection.close()


@router.post("/drafts", status_code=201)
async def create_draft(payload: DraftCreate, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        async with connection.transaction():
            base_revision = None
            if payload.product_id is not None:
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
                if successor_id is not None:
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
        row = await connection.fetchrow(
            "UPDATE v2_product_drafts SET data=$1::jsonb, change_kind=$2, "
            "revision=revision+1, updated_at=now() WHERE id=$3 AND author_id=$4 "
            "AND status='draft' AND revision=$5 "
            "AND NOT EXISTS (SELECT 1 FROM v2_products next "
            "WHERE next.predecessor_id=v2_product_drafts.product_id) RETURNING *",
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


@router.post("/drafts/{draft_id}/approve")
async def approve_draft(draft_id: int, request: Request):
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
            data = ProductData.model_validate(_decoded(draft["data"])).model_dump(
                mode="json"
            )
            _validate_publish(data)
            before = None
            if draft["product_id"] is not None:
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
                material = any(
                    before.get(key, "").strip() != data[key].strip()
                    for key in ("composition", "package", "quantity")
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
                    "SELECT p.id FROM v2_products p WHERE p.id IS DISTINCT FROM $2 "
                    "AND p.data->>'ean' <> '' "
                    "AND lpad(p.data->>'ean',14,'0')=lpad($1,14,'0') "
                    "AND NOT EXISTS (SELECT 1 FROM v2_products next "
                    "WHERE next.predecessor_id=p.id) LIMIT 1",
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
                user["id"],
                product["id"],
                draft_id,
            )
            return _product(product)
    finally:
        await connection.close()


def _off_snapshot_response(product_id: int, row) -> dict:
    payload = _decoded(row["payload"])
    presentation = build_sections(payload)
    modified = row["off_last_modified_t"]
    return {
        "product_id": product_id,
        "barcode": row["barcode"],
        "fetched_at": row["fetched_at"],
        "off_rev": row["off_rev"],
        "off_last_modified": (
            datetime.fromtimestamp(modified, tz=UTC) if modified is not None else None
        ),
        "off_url": f"{OFF_PRODUCT_PAGE}/{row['barcode']}",
        "field_count": len(payload),
        "presented_field_count": presentation.presented_count,
        "sections": presentation.sections,
    }


@router.get("/{product_id}/off")
async def get_product_off(product_id: int):
    connection = await _connect()
    try:
        product = await connection.fetchrow(
            "SELECT data FROM v2_products WHERE id=$1", product_id
        )
        if product is None:
            raise HTTPException(status_code=404, detail="Produit introuvable.")
        barcode = _decoded(product["data"]).get("ean", "")
        if not barcode:
            raise HTTPException(
                status_code=422, detail="Ce produit n'a pas de code EAN / GTIN."
            )
        row = await connection.fetchrow(
            "SELECT * FROM v2_product_off_snapshots WHERE product_id=$1",
            product_id,
        )
        if row is None or row["barcode"] != barcode:
            raise HTTPException(
                status_code=404, detail="Aucune fiche Open Food Facts enregistrée."
            )
        return _off_snapshot_response(product_id, row)
    finally:
        await connection.close()


@router.post("/{product_id}/off/refresh")
async def refresh_product_off(product_id: int, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        await _user(connection, request)
        product = await connection.fetchrow(
            "SELECT data FROM v2_products WHERE id=$1", product_id
        )
        if product is None:
            raise HTTPException(status_code=404, detail="Produit introuvable.")
        barcode = _decoded(product["data"]).get("ean", "")
        if not barcode:
            raise HTTPException(
                status_code=422, detail="Ce produit n'a pas de code EAN / GTIN."
            )
        barcode = normalize_barcode(barcode)
        try:
            payload = await fetch_full_off_product(barcode)
        except OffRateLimited as exc:
            raise HTTPException(
                status_code=429,
                detail="Trop de requêtes vers Open Food Facts. Réessayez plus tard.",
                headers=retry_after_headers(exc),
            ) from exc
        except OffUnavailable as exc:
            raise HTTPException(
                status_code=502,
                detail="Open Food Facts est temporairement indisponible.",
            ) from exc
        if payload is None:
            raise HTTPException(
                status_code=404, detail="Produit introuvable sur Open Food Facts."
            )
        row = await connection.fetchrow(
            """
            INSERT INTO v2_product_off_snapshots
                (product_id, barcode, payload, fetched_at, off_rev, off_last_modified_t)
            VALUES($1, $2, $3::jsonb, now(), $4, $5)
            ON CONFLICT(product_id) DO UPDATE SET
                barcode=excluded.barcode,
                payload=excluded.payload,
                fetched_at=excluded.fetched_at,
                off_rev=excluded.off_rev,
                off_last_modified_t=excluded.off_last_modified_t
            RETURNING *
            """,
            product_id,
            barcode,
            json.dumps(payload),
            _as_int(payload.get("rev")),
            _as_int(payload.get("last_modified_t")),
        )
        return _off_snapshot_response(product_id, row)
    finally:
        await connection.close()


@router.get("/{product_id}/history")
async def product_history(product_id: int):
    connection = await _connect()
    try:
        exists = await connection.fetchval(
            "SELECT EXISTS(SELECT 1 FROM v2_products WHERE id=$1)", product_id
        )
        if not exists:
            raise HTTPException(status_code=404, detail="Produit introuvable.")
        rows = await connection.fetch(
            "SELECT e.*, u.username AS actor FROM v2_product_events e "
            "JOIN v2_users u ON u.id=e.actor_id WHERE e.product_id=$1 "
            "ORDER BY e.created_at DESC, e.id DESC",
            product_id,
        )
        return [
            {
                "id": row["id"],
                "event_type": row["event_type"],
                "actor": row["actor"],
                "created_at": row["created_at"],
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
        row = await connection.fetchrow(
            "SELECT * FROM v2_products WHERE id=$1", product_id
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Produit introuvable.")
        product = _product(row)
        product["successor_id"] = await connection.fetchval(
            "SELECT id FROM v2_products WHERE predecessor_id=$1 "
            "ORDER BY id DESC LIMIT 1", product_id
        )
        return product
    finally:
        await connection.close()
