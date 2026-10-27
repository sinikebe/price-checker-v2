"""Account reports and administrator withdrawal of public content."""

from __future__ import annotations

import hashlib
from typing import Literal

import asyncpg
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.api.v2.auth import _bump_limit, _connect, _current_user, _secure_write
from app.services.v2_visibility import require_visible

router = APIRouter(prefix="/api/v2/moderation", tags=["v2-moderation"])


class ReportInput(BaseModel):
    kind: Literal["product", "recipe"]
    content_id: int = Field(gt=0)
    reason: str = Field(min_length=10, max_length=1000)


class ReportDecision(BaseModel):
    action: Literal["dismiss", "withdraw"]


async def _admin(connection, request: Request) -> dict:
    user = await _current_user(connection, request)
    if user is None or user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Accès administrateur requis.")
    return user


@router.get("/withdrawn")
async def withdrawn_ids():
    connection = await _connect()
    try:
        rows = await connection.fetch(
            "SELECT kind, content_id FROM v2_content_withdrawals "
            "ORDER BY kind, content_id"
        )
        return {
            "product_ids": [row["content_id"] for row in rows if row["kind"] == "product"],
            "recipe_ids": [row["content_id"] for row in rows if row["kind"] == "recipe"],
        }
    finally:
        await connection.close()


@router.post("/reports", status_code=201)
async def create_report(payload: ReportInput, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _current_user(connection, request)
        if user is None:
            raise HTTPException(status_code=401, detail="Connectez-vous pour signaler.")
        reason = payload.reason.strip()
        if len(reason) < 10:
            raise HTTPException(status_code=422, detail="Précisez le motif du signalement.")
        async with connection.transaction():
            key = hashlib.sha256(f"report:{user['id']}".encode()).hexdigest()
            if await _bump_limit(connection, key, 3600) > 10:
                raise HTTPException(status_code=429, detail="Trop de signalements.")
            await require_visible(connection, payload.kind, payload.content_id)
            report_id = await connection.fetchval(
                "INSERT INTO v2_content_reports(kind,content_id,reporter_id,reason) "
                "VALUES($1,$2,$3,$4) RETURNING id",
                payload.kind, payload.content_id, user["id"], reason,
            )
        return {"id": report_id, "status": "open"}
    except asyncpg.UniqueViolationError as exc:
        raise HTTPException(status_code=409, detail="Vous avez déjà signalé ce contenu.") from exc
    finally:
        await connection.close()


@router.get("/reports")
async def list_reports(
    request: Request,
    limit: int = Query(30, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    connection = await _connect()
    try:
        await _admin(connection, request)
        rows = await connection.fetch(
            "SELECT r.*, u.username AS reporter FROM v2_content_reports r "
            "JOIN v2_users u ON u.id=r.reporter_id WHERE r.status='open' "
            "ORDER BY r.created_at, r.id LIMIT $1 OFFSET $2",
            limit, offset,
        )
        return [dict(row) for row in rows]
    finally:
        await connection.close()


@router.post("/reports/{report_id}/resolve")
async def resolve_report(report_id: int, payload: ReportDecision, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        admin = await _admin(connection, request)
        async with connection.transaction():
            report = await connection.fetchrow(
                "SELECT * FROM v2_content_reports WHERE id=$1 FOR UPDATE", report_id,
            )
            if report is None or report["status"] != "open":
                raise HTTPException(status_code=409, detail="Signalement déjà traité.")
            if payload.action == "withdraw":
                await require_visible(connection, report["kind"], report["content_id"])
                await connection.execute(
                    "INSERT INTO v2_content_withdrawals"
                    "(kind,content_id,reason,withdrawn_by) VALUES($1,$2,$3,$4)",
                    report["kind"], report["content_id"], "Signalement traité", admin["id"],
                )
                collection = "products" if report["kind"] == "product" else "recipes"
                await connection.execute(
                    "UPDATE v2_pwa_versions SET revision=revision+1 "
                    "WHERE collection=$1", collection,
                )
                if report["kind"] == "product":
                    await connection.execute(
                        "UPDATE v2_product_drafts SET status='rejected',rejected_at=now(),"
                        "rejected_by=$2 WHERE product_id=$1 AND status='draft'",
                        report["content_id"], admin["id"],
                    )
                    await connection.execute(
                        "UPDATE v2_price_drafts SET status='rejected',reviewed_at=now(),"
                        "reviewed_by=$2 WHERE product_id=$1 AND status='draft'",
                        report["content_id"], admin["id"],
                    )
                status = "withdrawn"
                # Other open reports for the same content are closed together.
                await connection.execute(
                    "UPDATE v2_content_reports SET status='withdrawn',reviewed_at=now(),"
                    "reviewed_by=$3 WHERE kind=$1 AND content_id=$2 AND status='open'",
                    report["kind"], report["content_id"], admin["id"],
                )
            else:
                status = "dismissed"
                await connection.execute(
                    "UPDATE v2_content_reports SET status='dismissed',reviewed_at=now(),"
                    "reviewed_by=$2 WHERE id=$1", report_id, admin["id"],
                )
        return {"id": report_id, "status": status}
    except asyncpg.UniqueViolationError as exc:
        raise HTTPException(status_code=409, detail="Contenu déjà retiré.") from exc
    finally:
        await connection.close()
