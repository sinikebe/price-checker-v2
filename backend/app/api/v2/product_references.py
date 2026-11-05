"""Barcode-only products, created on demand (see app/services/v2_product_references.py).

When someone uses an Open Food Facts product we do not have (adds it to a basket, records a price),
the browser asks for a product that holds only its barcode. Nothing else is stored: no name, no
composition. The browser reads them from Open Food Facts whenever it shows the product.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.api.v2.auth import _bump_limit, _connect, _current_user, _secure_write, _session_user
from app.api.v2.auth_security import account_limit_key
from app.services import v2_open_prices_sync as open_prices
from app.services import v2_product_references as references
from app.services.barcodes import normalize_barcode

router = APIRouter(prefix="/api/v2/product-references", tags=["v2-product-references"])

CREATES_PER_HOUR = 60  # per account
UNUSED_BOUNDS = (0, 3650)  # days; 0 keeps them forever


def valid_check_digit(barcode: str) -> bool:
    """The GS1 check digit of an EAN-8, UPC-A, EAN-13 or GTIN-14."""
    digits = [int(char) for char in barcode]
    total = sum(digit * (3 if index % 2 == 0 else 1) for index, digit in enumerate(reversed(digits[:-1])))
    return (10 - total % 10) % 10 == digits[-1]


class ReferenceCreate(BaseModel):
    ean: str = Field(min_length=8, max_length=14)


@router.post("", status_code=201)
async def create_reference(payload: ReferenceCreate, request: Request, response: Response):
    """The product for this barcode: the existing one, or a new barcode-only product.

    Signed-in accounts only, at most CREATES_PER_HOUR a hour; the barcode must carry a valid check
    digit. Answers `{"id", "created"}` (201 when created, 200 when the product already existed).
    """
    _secure_write(request)
    response.headers["Cache-Control"] = "no-store"
    barcode = normalize_barcode(payload.ean)
    if not valid_check_digit(barcode):
        raise HTTPException(status_code=422, detail="Ce code-barres n’est pas valable (chiffre de contrôle).")
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        if await _bump_limit(connection, account_limit_key("product-reference", user["id"]), 3600) > CREATES_PER_HOUR:
            raise HTTPException(status_code=429, headers={"Retry-After": "3600"},
                                detail="Trop de produits ajoutés depuis Open Food Facts. Réessayez plus tard.")
        async with connection.transaction():
            # The same lock as a product approval, so a barcode never gets two current products.
            await connection.execute("SELECT pg_advisory_xact_lock(hashtextextended(lpad($1,14,'0'),0))", barcode)
            existing = await connection.fetchrow(
                "SELECT COALESCE(m.to_id,p.id) AS id, EXISTS(SELECT 1 FROM v2_content_withdrawals w "
                "WHERE w.kind='product' AND w.content_id=COALESCE(m.to_id,p.id)) AS withdrawn "
                "FROM v2_products p LEFT JOIN v2_content_merges m ON m.kind='product' AND m.from_id=p.id "
                "WHERE p.data->>'ean' <> '' AND lpad(p.data->>'ean',14,'0')=lpad($1,14,'0') "
                "AND NOT EXISTS (SELECT 1 FROM v2_products next WHERE next.predecessor_id=p.id) "
                "ORDER BY withdrawn, p.updated_at DESC, p.id DESC LIMIT 1", barcode)
            if existing is not None:
                if existing["withdrawn"]:
                    raise HTTPException(status_code=409, detail="Ce produit a été retiré du catalogue.")
                await references.touch(connection, [existing["id"]])
                response.status_code = 200
                return {"id": existing["id"], "created": False}
            product_id = await connection.fetchval(
                "INSERT INTO v2_products(data,off_reference) VALUES($1::jsonb,true) RETURNING id",
                json.dumps({"ean": barcode}))
            await connection.execute("INSERT INTO v2_product_reference_uses(product_id) VALUES($1)", product_id)
        # Its Open Prices readings, if any, are fetched now (a few seconds at most), so that the page
        # shows them when it opens; otherwise the regular sync takes it first at its next run.
        await open_prices.check_now(product_id, barcode)
        return {"id": product_id, "created": True}
    finally:
        await connection.close()


class ReferenceSettingsChange(BaseModel):
    unused_days: int = Field(ge=UNUSED_BOUNDS[0], le=UNUSED_BOUNDS[1])
    expected_revision: int = Field(ge=0)


async def _require_admin(connection, request: Request) -> None:
    user = await _current_user(connection, request)
    if user is None or user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Accès administrateur requis.")


async def _settings(connection) -> dict:
    row = await connection.fetchrow("SELECT unused_days,revision FROM v2_product_reference_settings WHERE singleton")
    count = await connection.fetchval("SELECT count(*) FROM v2_products WHERE off_reference")
    return {"unused_days": row["unused_days"], "revision": row["revision"], "count": count,
            "min": UNUSED_BOUNDS[0], "max": UNUSED_BOUNDS[1]}


@router.get("/settings")
async def read_settings(request: Request, response: Response):
    """How long an unused barcode-only product with nothing on our side is kept, and how many exist."""
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        await _require_admin(connection, request)
        return await _settings(connection)
    finally:
        await connection.close()


@router.put("/settings")
async def change_settings(payload: ReferenceSettingsChange, request: Request, response: Response):
    _secure_write(request)
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        await _require_admin(connection, request)
        updated = await connection.fetchval(
            "UPDATE v2_product_reference_settings SET unused_days=$1, revision=revision+1, updated_at=now() "
            "WHERE singleton AND revision=$2 RETURNING revision", payload.unused_days, payload.expected_revision)
        if updated is None:
            raise HTTPException(status_code=409, detail="Réglage modifié entre-temps. Rechargez la page.")
        return await _settings(connection)
    finally:
        await connection.close()
