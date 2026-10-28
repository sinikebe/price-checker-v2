"""Administrator-reviewed duplicate merges. Donor rows and audit snapshots are retained."""

from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator

from app.api.v2.auth import _connect, _secure_write
from app.api.v2.moderation import _admin
from app.api.v2.products import ProductData, _decoded, _validate_publish
from app.api.v2.stores import name_key
from app.services.v2_visibility import require_visible

router = APIRouter(prefix="/api/v2/moderation", tags=["v2-duplicate-merges"])
PRODUCT_FIELDS = tuple(key for key in ProductData.model_fields if key not in {
    "quantity_amount", "quantity_unit", "quantity_count_noun"})
STORE_FIELDS = ("name", "city", "postal_code", "latitude", "longitude",
                "supports_drive", "supports_delivery", "external_store_id",
                "osm_type", "osm_id")


class MergeInput(BaseModel):
    duplicate_id: int = Field(gt=0)
    origin_revision: int = Field(ge=1)
    duplicate_revision: int = Field(ge=1)
    origin_fingerprint: str
    duplicate_fingerprint: str
    result: dict[str, Any]
    confirmed_fields: list[str]


class StoreMergeData(BaseModel):
    name: str = Field(min_length=1,max_length=300)
    city: str = Field(min_length=1,max_length=200)
    postal_code: str = Field(min_length=1,max_length=20)
    latitude: Decimal | None = Field(ge=-90,le=90)
    longitude: Decimal | None = Field(ge=-180,le=180)
    supports_drive: bool
    supports_delivery: bool
    external_store_id: str | None = Field(max_length=100)
    osm_type: str | None = Field(max_length=20)
    osm_id: int | None = Field(ge=1)

    @field_validator("name","city","postal_code")
    @classmethod
    def nonblank(cls,value: str) -> str:
        cleaned=value.strip()
        if not cleaned:
            raise ValueError("Champ magasin obligatoire.")
        return cleaned


def _fingerprint(value: dict) -> str:
    return hashlib.sha256(json.dumps(value,sort_keys=True,default=str).encode()).hexdigest()


def _empty(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def _fields(kind: str, origin: dict, duplicate: dict) -> list[dict]:
    keys = PRODUCT_FIELDS if kind == "product" else STORE_FIELDS
    result = []
    for key in keys:
        left, right = origin.get(key), duplicate.get(key)
        state = ("identical" if left == right else
                 "one_sided" if _empty(left) != _empty(right) else "conflict")
        result.append({"key": key, "origin": left, "duplicate": right,
                       "state": state,
                       "suggested": right if _empty(left) else left})
    return result


async def _pair(connection, report, duplicate_id: int, *, lock: bool = False):
    kind = report["kind"]
    origin_id = report["content_id"]
    if kind not in ("product", "store") or duplicate_id == origin_id:
        raise HTTPException(status_code=422, detail="Choisissez deux fiches distinctes du même type.")
    table = "v2_products" if kind == "product" else "v2_stores"
    suffix = " FOR UPDATE" if lock else ""
    rows = await connection.fetch(
        f"SELECT * FROM {table} WHERE id=ANY($1::bigint[]) ORDER BY id" + suffix,
        [origin_id, duplicate_id],
    )
    by_id = {row["id"]: row for row in rows}
    if len(by_id) != 2:
        raise HTTPException(status_code=404, detail="Une des deux fiches est introuvable.")
    origin, duplicate = by_id[origin_id], by_id[duplicate_id]
    for item in (origin, duplicate):
        if await connection.fetchval(
            "SELECT EXISTS(SELECT 1 FROM v2_content_merges WHERE kind=$1 AND from_id=$2)",
            kind, item["id"],
        ):
            raise HTTPException(status_code=409, detail="Une fiche a déjà été fusionnée.")
        if kind == "product":
            await require_visible(connection, kind, item["id"])
            if await connection.fetchval(
                "SELECT EXISTS(SELECT 1 FROM v2_products WHERE predecessor_id=$1)",item["id"]
            ):
                raise HTTPException(status_code=409, detail="Choisissez la version actuelle du produit.")
    if kind == "store":
        for item in (origin, duplicate):
            public = await connection.fetchval(
                "SELECT EXISTS(SELECT 1 FROM v2_stores s WHERE s.id=$1 "
                "AND (s.osm_id IS NOT NULL OR EXISTS(SELECT 1 FROM v2_price_observations o "
                "WHERE o.store_id=s.id)))",item["id"])
            if not public:
                raise HTTPException(status_code=404, detail="Magasin public introuvable.")
    if kind == "store" and origin["retailer_id"] != duplicate["retailer_id"]:
        raise HTTPException(status_code=422, detail="Les magasins doivent appartenir à la même enseigne.")
    origin_data = ProductData.model_validate(_decoded(origin["data"])).model_dump(mode="json") if kind == "product" else {
        key: origin[key] for key in STORE_FIELDS}
    duplicate_data = ProductData.model_validate(_decoded(duplicate["data"])).model_dump(mode="json") if kind == "product" else {
        key: duplicate[key] for key in STORE_FIELDS}
    if kind == "store":
        origin_data = json.loads(json.dumps(origin_data, default=str))
        duplicate_data = json.loads(json.dumps(duplicate_data, default=str))
    return origin, duplicate, origin_data, duplicate_data


async def _report(connection, report_id: int, *, lock: bool = False):
    row = await connection.fetchrow(
        "SELECT r.*,u.username AS reporter FROM v2_content_reports r "
        "LEFT JOIN v2_users u ON u.id=r.reporter_id WHERE r.id=$1" +
        (" FOR UPDATE OF r" if lock else ""), report_id,
    )
    if row is None or row["report_type"] != "duplicate":
        raise HTTPException(status_code=404, detail="Signalement de doublon introuvable.")
    if row["status"] != "open":
        raise HTTPException(status_code=409, detail="Signalement déjà traité.")
    return row


@router.get("/duplicate-candidates")
async def candidates(request: Request, kind: Literal["product", "store"],
                     q: str = Query("", max_length=100)):
    connection = await _connect()
    try:
        await _admin(connection, request)
        term = "%" + q.strip().lower() + "%"
        if kind == "product":
            rows = await connection.fetch(
                "SELECT p.id,p.data->>'name' AS name,p.data->>'brand' AS detail,"
                "p.data->>'ean' AS code FROM v2_products p WHERE "
                "(lower(p.data->>'name') LIKE $1 OR lower(p.data->>'brand') LIKE $1 "
                "OR p.data->>'ean' LIKE $1 OR p.id::text=$2) "
                "AND NOT EXISTS(SELECT 1 FROM v2_products n WHERE n.predecessor_id=p.id) "
                "AND NOT EXISTS(SELECT 1 FROM v2_content_withdrawals w "
                "WHERE w.kind='product' AND w.content_id=p.id) "
                "AND NOT EXISTS(SELECT 1 FROM v2_content_merges m "
                "WHERE m.kind='product' AND m.from_id=p.id) "
                "ORDER BY p.id DESC LIMIT 30", term, q.strip(),
            )
        else:
            rows = await connection.fetch(
                "SELECT s.id,s.name,r.name || ' · ' || COALESCE(s.city,'') AS detail,"
                "s.postal_code AS code FROM v2_stores s "
                "JOIN v2_retailers r ON r.id=s.retailer_id WHERE "
                "(lower(s.name) LIKE $1 OR lower(r.name) LIKE $1 OR "
                "lower(COALESCE(s.city,'')) LIKE $1 OR s.postal_code LIKE $1 OR s.id::text=$2) "
                "AND NOT EXISTS(SELECT 1 FROM v2_content_merges m "
                "WHERE m.kind='store' AND m.from_id=s.id) "
                "ORDER BY s.id DESC LIMIT 30", term, q.strip(),
            )
        return [dict(row) for row in rows]
    finally:
        await connection.close()


@router.get("/reports/{report_id}/duplicate")
async def duplicate_report(report_id: int, request: Request):
    connection = await _connect()
    try:
        await _admin(connection, request)
        report = await _report(connection, report_id)
        table = "v2_products" if report["kind"] == "product" else "v2_stores"
        row = await connection.fetchrow(f"SELECT * FROM {table} WHERE id=$1",report["content_id"])
        if row is None:
            raise HTTPException(status_code=404, detail="Fiche d'origine introuvable.")
        data = _decoded(row["data"]) if report["kind"] == "product" else {
            key: row[key] for key in STORE_FIELDS}
        return {"report": dict(report), "origin": {"id": row["id"], "data": data}}
    finally:
        await connection.close()


@router.get("/reports/{report_id}/merge-preview")
async def merge_preview(report_id: int, request: Request, duplicate_id: int = Query(gt=0)):
    connection = await _connect()
    try:
        await _admin(connection, request)
        report = await _report(connection, report_id)
        origin, duplicate, a, b = await _pair(connection, report, duplicate_id)
        return {"kind": report["kind"], "origin_id": origin["id"],
                "duplicate_id": duplicate["id"],
                "origin_revision": origin["revision"] if report["kind"] == "product" else 1,
                "duplicate_revision": duplicate["revision"] if report["kind"] == "product" else 1,
                "origin_fingerprint": _fingerprint(a),
                "duplicate_fingerprint": _fingerprint(b),
                "fields": _fields(report["kind"], a, b)}
    finally:
        await connection.close()


@router.post("/reports/{report_id}/merge")
async def merge(report_id: int, payload: MergeInput, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        admin = await _admin(connection, request)
        async with connection.transaction():
            report = await _report(connection, report_id, lock=True)
            origin, duplicate, a, b = await _pair(
                connection, report, payload.duplicate_id, lock=True)
            kind = report["kind"]
            if (payload.origin_revision != (origin["revision"] if kind == "product" else 1)
                    or payload.duplicate_revision != (duplicate["revision"] if kind == "product" else 1)):
                raise HTTPException(status_code=409, detail="Une fiche a changé. Rechargez la comparaison.")
            if payload.origin_fingerprint != _fingerprint(a) or payload.duplicate_fingerprint != _fingerprint(b):
                raise HTTPException(status_code=409, detail="Une fiche a changé. Rechargez la comparaison.")
            fields = _fields(kind, a, b)
            keys = {field["key"] for field in fields}
            required = {field["key"] for field in fields if field["state"] != "identical"}
            if set(payload.result) != keys or not required.issubset(set(payload.confirmed_fields)):
                raise HTTPException(status_code=422, detail="Validez chaque champ orange et résolvez chaque champ rouge.")
            for field in fields:
                if field["state"] == "identical" and payload.result[field["key"]] != field["origin"]:
                    raise HTTPException(status_code=422, detail="Un champ identique a été modifié.")
            if kind == "product":
                try:
                    result = ProductData.model_validate(payload.result).model_dump(mode="json")
                except ValueError as exc:
                    raise HTTPException(status_code=422, detail="Fiche produit résultante invalide.") from exc
                _validate_publish(result)
                if result["ean"]:
                    collision = await connection.fetchval(
                        "SELECT p.id FROM v2_products p LEFT JOIN v2_content_merges m "
                        "ON m.kind='product' AND m.from_id=p.id "
                        "WHERE COALESCE(m.to_id,p.id) <> ALL($2::bigint[]) "
                        "AND p.data->>'ean'<>'' AND lpad(p.data->>'ean',14,'0')=lpad($1,14,'0') "
                        "AND NOT EXISTS(SELECT 1 FROM v2_products n WHERE n.predecessor_id=p.id) "
                        "AND NOT EXISTS(SELECT 1 FROM v2_content_merges m "
                        "WHERE m.kind='product' AND m.from_id=p.id) LIMIT 1",
                        result["ean"],[origin["id"],duplicate["id"]],
                    )
                    if collision:
                        raise HTTPException(status_code=409, detail="Ce code-barres appartient à une troisième fiche.")
                await connection.execute(
                    "UPDATE v2_products SET data=$1::jsonb,revision=revision+1,updated_at=now() WHERE id=$2",
                    json.dumps(result),origin["id"],
                )
                await connection.execute(
                    "INSERT INTO v2_product_events(product_id,actor_id,event_type,before_data,after_data) "
                    "VALUES($1,$2,'merge',$3::jsonb,$4::jsonb)",
                    origin["id"],admin["id"],json.dumps(a),json.dumps(result),
                )
                await connection.execute("UPDATE v2_price_drafts SET product_id=$1 WHERE product_id=$2",origin["id"],duplicate["id"])
                await connection.execute("UPDATE v2_price_observations SET product_id=$1 WHERE product_id=$2",origin["id"],duplicate["id"])
                await connection.execute("UPDATE v2_recipe_ingredients SET product_id=$1 WHERE product_id=$2",origin["id"],duplicate["id"])
                await connection.execute("UPDATE v2_transfer_product_map SET target_id=$1 WHERE target_id=$2",origin["id"],duplicate["id"])
                await connection.execute(
                    "UPDATE v2_offer_product_links SET product_id=$1 WHERE product_id=$2 "
                    "AND NOT EXISTS(SELECT 1 FROM v2_offer_product_links other "
                    "WHERE other.offer_id=v2_offer_product_links.offer_id AND other.product_id=$1)",
                    origin["id"],duplicate["id"],
                )
                await connection.execute("DELETE FROM v2_off_refresh_queue WHERE product_id=$1",duplicate["id"])
                await connection.execute("DELETE FROM v2_open_prices_sync_state WHERE product_id=$1",duplicate["id"])
                await connection.execute(
                    "UPDATE v2_product_drafts SET status='rejected',rejected_at=now(),rejected_by=$1 "
                    "WHERE product_id=$2 AND status='draft'",admin["id"],duplicate["id"],
                )
                await connection.execute("UPDATE v2_pwa_versions SET revision=revision+1 WHERE collection='products'")
            else:
                try:
                    result = StoreMergeData.model_validate(payload.result).model_dump()
                except ValueError as exc:
                    raise HTTPException(status_code=422, detail="Fiche magasin résultante invalide.") from exc
                if (result["osm_id"] is None) != (result["osm_type"] is None):
                    raise HTTPException(status_code=422, detail="Identifiant OSM incomplet.")
                for source in (origin,duplicate):
                    if source["osm_type"] is not None and source["osm_id"] is not None:
                        await connection.execute(
                            "INSERT INTO v2_store_osm_aliases(osm_type,osm_id,store_id) "
                            "VALUES($1,$2,$3) ON CONFLICT(osm_type,osm_id) DO UPDATE "
                            "SET store_id=EXCLUDED.store_id",
                            source["osm_type"],source["osm_id"],origin["id"],
                        )
                # Free donor's unique OSM identity, retained in the audit snapshot.
                await connection.execute("UPDATE v2_stores SET osm_type=NULL,osm_id=NULL WHERE id=$1",duplicate["id"])
                try:
                    await connection.execute(
                        "UPDATE v2_stores SET name=$1,city=$2,postal_code=$3,latitude=$4,longitude=$5,"
                        "supports_drive=$6,supports_delivery=$7,external_store_id=$8,osm_type=$9,osm_id=$10 "
                        "WHERE id=$11",result["name"],result["city"],result["postal_code"],
                        result["latitude"],result["longitude"],result["supports_drive"],
                        result["supports_delivery"],result["external_store_id"],
                        result["osm_type"],result["osm_id"],origin["id"],
                    )
                except (TypeError, ValueError) as exc:
                    raise HTTPException(status_code=422, detail="Champ magasin invalide.") from exc
                await connection.execute("UPDATE v2_price_drafts SET store_id=$1 WHERE store_id=$2",origin["id"],duplicate["id"])
                await connection.execute("UPDATE v2_offers SET store_id=$1 WHERE store_id=$2",origin["id"],duplicate["id"])
                await connection.execute("UPDATE v2_price_observations SET store_id=$1 WHERE store_id=$2",origin["id"],duplicate["id"])
                await connection.execute(
                    "INSERT INTO v2_store_aliases(store_id,source,name,name_key,approved_by) "
                    "SELECT $1,source,name,name_key,approved_by FROM v2_store_aliases WHERE store_id=$2 "
                    "ON CONFLICT DO NOTHING",origin["id"],duplicate["id"],
                )
                await connection.execute(
                    "UPDATE v2_store_alias_proposals p SET status='rejected',reviewed_by=$3,reviewed_at=now() "
                    "WHERE p.store_id=$2 AND p.status='pending' AND EXISTS "
                    "(SELECT 1 FROM v2_store_alias_proposals other WHERE other.store_id=$1 "
                    "AND other.status='pending' AND other.source=p.source AND other.name_key=p.name_key)",
                    origin["id"],duplicate["id"],admin["id"],
                )
                for old_name in (origin["name"],duplicate["name"]):
                    if name_key(old_name) != name_key(result["name"]):
                        await connection.execute(
                            "INSERT INTO v2_store_aliases(store_id,source,name,name_key,approved_by) "
                            "VALUES($1,'retailer',$2,$3,$4) ON CONFLICT DO NOTHING",
                            origin["id"],old_name,name_key(old_name),admin["id"],
                        )
                await connection.execute("UPDATE v2_store_alias_proposals SET store_id=$1 WHERE store_id=$2 AND status='pending'",origin["id"],duplicate["id"])
                await connection.execute("UPDATE v2_store_osm_aliases SET store_id=$1 WHERE store_id=$2",origin["id"],duplicate["id"])
            await connection.execute(
                "INSERT INTO v2_content_merges(kind,from_id,to_id,report_id,from_snapshot,to_snapshot,"
                "result_snapshot,merged_by) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8)",
                kind,duplicate["id"],origin["id"],report_id,
                json.dumps(b),json.dumps(a),json.dumps(result,default=str),admin["id"],
            )
            await connection.execute(
                "UPDATE v2_content_merges SET to_id=$1 WHERE kind=$2 AND to_id=$3",
                origin["id"],kind,duplicate["id"],
            )
            await connection.execute(
                "UPDATE v2_content_reports SET status='merged',duplicate_id=$1,reviewed_at=now(),reviewed_by=$2 "
                "WHERE id=$3",duplicate["id"],admin["id"],report_id,
            )
            await connection.execute(
                "UPDATE v2_content_reports SET status='merged',reviewed_at=now(),reviewed_by=$3 "
                "WHERE kind=$1 AND report_type='duplicate' AND status='open' "
                "AND (content_id=$2 OR duplicate_id=$2)",kind,duplicate["id"],admin["id"],
            )
        return {"id":origin["id"],"merged_from_id":duplicate["id"],"status":"merged"}
    finally:
        await connection.close()
