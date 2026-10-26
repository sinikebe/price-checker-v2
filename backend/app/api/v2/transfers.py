"""Portable, admin-only V2 product and published-price snapshots."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, ValidationError, field_validator

from app.api.v2.auth import _connect, _secure_write
from app.api.v2.products import ProductData, _validate_publish
from app.api.v2.setup import _require_admin

router = APIRouter(prefix="/api/v2/transfers", tags=["v2-transfers"])
MAX_BUNDLE_BYTES = 24 * 1024 * 1024
MAX_ID = 9223372036854775807


class TransferProduct(BaseModel):
    id: int = Field(ge=1, le=MAX_ID)
    predecessor_id: int | None = Field(default=None, ge=1, le=MAX_ID)
    data: ProductData


class TransferRetailer(BaseModel):
    id: int = Field(ge=1, le=MAX_ID)
    name: str = Field(min_length=1, max_length=200)


class TransferStore(BaseModel):
    id: int = Field(ge=1, le=MAX_ID)
    retailer_id: int = Field(ge=1, le=MAX_ID)
    name: str = Field(min_length=1, max_length=300)
    city: str | None = Field(default=None, max_length=200)
    postal_code: str | None = Field(default=None, max_length=20)
    supports_drive: bool = False
    supports_delivery: bool = False


class TransferPrice(BaseModel):
    id: int = Field(ge=1, le=MAX_ID)
    product_id: int = Field(ge=1, le=MAX_ID)
    store_id: int = Field(ge=1, le=MAX_ID)
    source: Literal["manual", "connector", "third_party"]
    source_provider: str | None = Field(default=None, max_length=50)
    price: Decimal = Field(ge=0, max_digits=10, decimal_places=2)
    quantity_text: str | None = Field(default=None, max_length=100)
    unit_price_amount: Decimal | None = Field(default=None, ge=0, max_digits=10, decimal_places=2)
    unit_price_unit: str | None = Field(default=None, max_length=20)
    available: bool = True
    observed_at: datetime
    note: str | None = Field(default=None, max_length=1000)
    sales_channel: Literal["in_store", "drive", "delivery"] = "in_store"

    @field_validator("observed_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("La date du relevé doit inclure un fuseau horaire.")
        return value


class TransferBundle(BaseModel):
    format: Literal["price-checker-v2-transfer"]
    schema_version: Literal[1]
    source_instance: UUID
    products: list[TransferProduct] = Field(max_length=10000)
    retailers: list[TransferRetailer] = Field(max_length=10000)
    stores: list[TransferStore] = Field(max_length=30000)
    prices: list[TransferPrice] = Field(max_length=100000)


def _dicts(rows: list[BaseModel], label: str) -> dict[int, BaseModel]:
    indexed = {row.id: row for row in rows}
    if len(indexed) != len(rows):
        raise HTTPException(status_code=422, detail=f"Identifiants {label} répétés.")
    return indexed


def _fingerprint(product: TransferProduct) -> str:
    canonical = json.dumps(
        {"predecessor_id": product.predecessor_id,
         "data": product.data.model_dump(mode="json")},
        sort_keys=True, ensure_ascii=False, separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def _key(source: UUID, kind: str, source_id: int) -> str:
    return f"pcv2:{source.hex}:{kind}:{source_id}"


def _decoded(value):
    return json.loads(value) if isinstance(value, str) else value


@router.get("/export")
async def export_products_prices(request: Request):
    await _require_admin(request)
    connection = await _connect()
    try:
        source = await connection.fetchval(
            "SELECT instance_id FROM v2_transfer_instance WHERE singleton=true"
        )
        hidden = await connection.fetchval(
            "SELECT EXISTS(SELECT 1 FROM v2_content_withdrawals "
            "WHERE kind='product')"
        )
        if hidden:
            raise HTTPException(
                status_code=409,
                detail="Export bloqué : un contenu retiré nécessite une sélection manuelle.",
            )
        products = await connection.fetch(
            "SELECT id, predecessor_id, data FROM v2_products ORDER BY id"
        )
        prices = await connection.fetch(
            "SELECT id, product_id, store_id, source, source_provider, price, "
            "quantity_text, unit_price_amount, unit_price_unit, available, "
            "observed_at, note, sales_channel FROM v2_price_observations "
            "WHERE product_id IS NOT NULL AND NOT superseded "
            "AND correction_status IS DISTINCT FROM 'active' ORDER BY id"
        )
        stores = await connection.fetch(
            "SELECT id, retailer_id, name, city, postal_code, supports_drive, "
            "supports_delivery FROM v2_stores WHERE id = ANY($1::bigint[]) ORDER BY id",
            [row["store_id"] for row in prices],
        )
        retailers = await connection.fetch(
            "SELECT id, name FROM v2_retailers WHERE id = ANY($1::bigint[]) ORDER BY id",
            [row["retailer_id"] for row in stores],
        )
        bundle = {
            "format": "price-checker-v2-transfer", "schema_version": 1,
            "source_instance": str(source),
            "products": [{"id": row["id"], "predecessor_id": row["predecessor_id"],
                          "data": _decoded(row["data"])} for row in products],
            "retailers": [dict(row) for row in retailers],
            "stores": [dict(row) for row in stores],
            "prices": [{**dict(row), "price": str(row["price"]),
                        "unit_price_amount": (str(row["unit_price_amount"])
                                              if row["unit_price_amount"] is not None else None),
                        "observed_at": row["observed_at"].isoformat()} for row in prices],
        }
        body = json.dumps(bundle, ensure_ascii=False, separators=(",", ":")).encode()
        if len(body) > MAX_BUNDLE_BYTES:
            raise HTTPException(status_code=413, detail="Export trop volumineux pour le transfert Web.")
        return Response(
            content=body, media_type="application/json",
            headers={"Content-Disposition": 'attachment; filename="price-checker-v2-transfer.json"',
                     "Cache-Control": "no-store"},
        )
    finally:
        await connection.close()


@router.post("/import")
async def import_products_prices(request: Request):
    _secure_write(request)
    await _require_admin(request)
    body = bytearray()
    async for part in request.stream():
        body.extend(part)
        if len(body) > MAX_BUNDLE_BYTES:
            raise HTTPException(status_code=413, detail="Fichier de transfert trop volumineux.")
    try:
        bundle = TransferBundle.model_validate_json(body)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail="Format de transfert V2 invalide.") from exc
    products = _dicts(bundle.products, "produit")
    for product in bundle.products:
        _validate_publish(product.data.model_dump(mode="json"))
    retailers = _dicts(bundle.retailers, "enseigne")
    stores = _dicts(bundle.stores, "point de vente")
    prices = _dicts(bundle.prices, "prix")
    if any(p.predecessor_id is not None and p.predecessor_id not in products
           for p in bundle.products):
        raise HTTPException(status_code=422, detail="Version de produit précédente manquante.")
    if any(s.retailer_id not in retailers for s in bundle.stores):
        raise HTTPException(status_code=422, detail="Enseigne d'un point de vente manquante.")
    if any(p.product_id not in products or p.store_id not in stores for p in bundle.prices):
        raise HTTPException(status_code=422, detail="Produit ou point de vente d'un prix manquant.")
    connection = await _connect()
    try:
        async with connection.transaction():
            await connection.execute("SELECT pg_advisory_xact_lock(795244, 1)")
            own = await connection.fetchval(
                "SELECT instance_id FROM v2_transfer_instance WHERE singleton=true"
            )
            if own == bundle.source_instance:
                raise HTTPException(status_code=409, detail="Cette archive provient de cette instance.")
            source = bundle.source_instance
            product_map: dict[int, int] = {}
            pending = dict(products)
            inserted_products = 0
            while pending:
                progress = False
                for source_id, product in list(pending.items()):
                    if product.predecessor_id is not None and product.predecessor_id not in product_map:
                        continue
                    fingerprint = _fingerprint(product)
                    mapped = await connection.fetchrow(
                        "SELECT target_id, fingerprint FROM v2_transfer_product_map "
                        "WHERE source_instance=$1 AND source_id=$2", source, source_id,
                    )
                    if mapped is not None:
                        target = await connection.fetchrow(
                            "SELECT data, predecessor_id FROM v2_products WHERE id=$1", mapped["target_id"]
                        )
                        if target is None or mapped["fingerprint"] != fingerprint or (
                            ProductData.model_validate(_decoded(target["data"])).model_dump(mode="json")
                            != product.data.model_dump(mode="json")
                        ) or target["predecessor_id"] != (
                            product_map.get(product.predecessor_id)
                        ):
                            raise HTTPException(
                                status_code=409,
                                detail=f"Produit {source_id} modifié depuis le précédent import.",
                            )
                        target_id = mapped["target_id"]
                    else:
                        ean = product.data.ean
                        if ean and source_id not in {
                            p.predecessor_id for p in bundle.products if p.predecessor_id is not None
                        }:
                            ancestors = []
                            previous = product.predecessor_id
                            while previous is not None:
                                ancestors.append(product_map[previous])
                                previous = products[previous].predecessor_id
                            collision = await connection.fetchval(
                                "SELECT p.id FROM v2_products p WHERE p.data->>'ean' <> '' "
                                "AND lpad(p.data->>'ean',14,'0')=lpad($1,14,'0') "
                                "AND NOT EXISTS (SELECT 1 FROM v2_products n WHERE n.predecessor_id=p.id) "
                                "AND NOT (p.id = ANY($2::bigint[])) "
                                "LIMIT 1", ean, ancestors,
                            )
                            if collision is not None:
                                raise HTTPException(
                                    status_code=409,
                                    detail=f"Code-barres déjà présent sur cette instance : {ean}.",
                                )
                        target_id = await connection.fetchval(
                            "INSERT INTO v2_products(data,predecessor_id) "
                            "VALUES($1::jsonb,$2) RETURNING id",
                            json.dumps(product.data.model_dump(mode="json"), ensure_ascii=False),
                            product_map.get(product.predecessor_id),
                        )
                        await connection.execute(
                            "INSERT INTO v2_transfer_product_map "
                            "(source_instance,source_id,target_id,fingerprint) VALUES($1,$2,$3,$4)",
                            source, source_id, target_id, fingerprint,
                        )
                        inserted_products += 1
                    product_map[source_id] = target_id
                    del pending[source_id]
                    progress = True
                if not progress:
                    raise HTTPException(status_code=422, detail="Cycle dans les versions produit.")
            retailer_map: dict[int, int] = {}
            for source_id, retailer in retailers.items():
                key = _key(source, "r", source_id)
                target_id = await connection.fetchval(
                    "INSERT INTO v2_retailers(code,name,import_key) "
                    "VALUES($1,$2,$3) ON CONFLICT(import_key) DO UPDATE "
                    "SET import_key=EXCLUDED.import_key RETURNING id",
                    "xfer-" + hashlib.sha256(key.encode()).hexdigest()[:32],
                    retailer.name, key,
                )
                retailer_map[source_id] = target_id
            store_map: dict[int, int] = {}
            for source_id, store in stores.items():
                key = _key(source, "s", source_id)
                target_id = await connection.fetchval(
                    "INSERT INTO v2_stores(retailer_id,name,city,postal_code,"
                    "supports_drive,supports_delivery,import_key) "
                    "VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(import_key) DO UPDATE "
                    "SET import_key=EXCLUDED.import_key RETURNING id",
                    retailer_map[store.retailer_id], store.name, store.city,
                    store.postal_code, store.supports_drive, store.supports_delivery, key,
                )
                store_map[source_id] = target_id
            inserted_prices = 0
            for source_id, price in prices.items():
                key = _key(source, "p", source_id)
                present = await connection.fetchval(
                    "SELECT id FROM v2_price_observations WHERE import_key=$1", key
                )
                if present is not None:
                    continue
                await connection.execute(
                    "INSERT INTO v2_price_observations("
                    "product_id,retailer_id,store_id,source,source_provider,"
                    "source_record_id,price,quantity_text,unit_price_amount,"
                    "unit_price_unit,available,observed_at,note,sales_channel,import_key) "
                    "VALUES($1,$2,$3,'third_party','price-checker-v2',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
                    product_map[price.product_id],
                    retailer_map[stores[price.store_id].retailer_id],
                    store_map[price.store_id], f"{source}:{source_id}",
                    price.price, price.quantity_text, price.unit_price_amount,
                    price.unit_price_unit, price.available, price.observed_at,
                    price.note, price.sales_channel, key,
                )
                inserted_prices += 1
        return {"products_imported": inserted_products, "prices_imported": inserted_prices,
                "products_already_present": len(products) - inserted_products,
                "prices_already_present": len(prices) - inserted_prices}
    except asyncpg.UniqueViolationError as exc:
        raise HTTPException(status_code=409, detail="Conflit d'identité pendant l'import.") from exc
    finally:
        await connection.close()
