"""Browser-managed second factors and scoped personal API tokens."""

from __future__ import annotations

import hmac
import secrets
import time
from datetime import timedelta
from typing import Literal

import pyotp
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, SecretStr

from app.api.v2.auth import (
    _bump_limit, _connect, _limit_key, _secure_write, _session_user,
    _token_hash, _verify_password,
)
from app.api.v2.auth_security import (
    account_limit_key, decrypt_seed, encrypt_seed, new_recovery_codes,
    recovery_hash, verify_second_factor,
)

router = APIRouter(prefix="/api/v2/account/security", tags=["v2-account-security"])


class PasswordProof(BaseModel):
    password: SecretStr


class SecondFactorProof(PasswordProof):
    second_factor: str | None = Field(default=None, max_length=80)


class MfaConfirmation(BaseModel):
    code: str = Field(min_length=6, max_length=6, pattern=r"^[0-9]{6}$")


class TokenCreation(SecondFactorProof):
    label: str = Field(min_length=1, max_length=80)
    scope: Literal["read", "contribute"] = "read"
    expires_in_days: int = Field(default=90, ge=1, le=365)


async def _rate_limit(connection, request: Request, user_id: int) -> None:
    key = _limit_key("account-security", request, str(user_id))
    if await _bump_limit(connection, key, 3600) > 20:
        raise HTTPException(status_code=429, detail="Trop de tentatives. Réessayez plus tard.")
    if await _bump_limit(connection, account_limit_key("security-action", user_id), 3600) > 20:
        raise HTTPException(status_code=429, detail="Trop de tentatives. Réessayez plus tard.")


async def _password_proof(connection, user_id: int, password: SecretStr) -> None:
    value = password.get_secret_value()
    if not value or len(value.encode("utf-8")) > 1024:
        raise HTTPException(status_code=401, detail="Vérification incorrecte.")
    encoded = await connection.fetchval(
        "SELECT password_hash FROM v2_users WHERE id=$1 FOR UPDATE", user_id,
    )
    if encoded is None or not await _verify_password(encoded, value):
        raise HTTPException(status_code=401, detail="Vérification incorrecte.")


async def _full_proof(connection, user_id: int, proof: SecondFactorProof) -> None:
    await _password_proof(connection, user_id, proof.password)
    if not await verify_second_factor(connection, user_id, proof.second_factor):
        raise HTTPException(status_code=401, detail="Code de validation incorrect.")


@router.get("/mfa", summary="État de la double authentification")
async def mfa_status(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        row = await connection.fetchrow(
            "SELECT enabled_at,pending_expires_at FROM v2_mfa_credentials "
            "WHERE user_id=$1", user["id"],
        )
        count = await connection.fetchval(
            "SELECT count(*) FROM v2_mfa_recovery_codes WHERE user_id=$1", user["id"],
        )
        return {"enabled": bool(row and row["enabled_at"]),
                "pending": bool(row and row["enabled_at"] is None and
                                row["pending_expires_at"] is not None and
                                row["pending_expires_at"].timestamp() > time.time()),
                "recovery_codes_remaining": count}
    finally:
        await connection.close()


@router.post("/mfa/setup", summary="Préparer une clé TOTP")
async def mfa_setup(proof: PasswordProof, request: Request, response: Response):
    _secure_write(request)
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        await _rate_limit(connection, request, user["id"])
        async with connection.transaction():
            await _password_proof(connection, user["id"], proof.password)
            enabled = await connection.fetchval(
                "SELECT enabled_at IS NOT NULL FROM v2_mfa_credentials "
                "WHERE user_id=$1 FOR UPDATE", user["id"],
            )
            if enabled:
                raise HTTPException(status_code=409, detail="Double authentification déjà activée.")
            secret = pyotp.random_base32()
            await connection.execute(
                "INSERT INTO v2_mfa_credentials(user_id,secret_ciphertext,pending_expires_at) "
                "VALUES($1,$2,now()+interval '15 minutes') ON CONFLICT(user_id) "
                "DO UPDATE SET secret_ciphertext=EXCLUDED.secret_ciphertext, "
                "pending_expires_at=EXCLUDED.pending_expires_at,created_at=now(),last_step=NULL",
                user["id"], encrypt_seed(secret),
            )
        return {"secret": secret,
                "provisioning_uri": pyotp.TOTP(secret).provisioning_uri(
                    name=user["username"], issuer_name="Price Checker")}
    finally:
        await connection.close()


@router.post("/mfa/confirm", summary="Activer TOTP et créer les codes de secours")
async def mfa_confirm(payload: MfaConfirmation, request: Request, response: Response):
    _secure_write(request)
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        await _rate_limit(connection, request, user["id"])
        async with connection.transaction():
            await connection.fetchval(
                "SELECT id FROM v2_users WHERE id=$1 FOR UPDATE", user["id"],
            )
            row = await connection.fetchrow(
                "SELECT secret_ciphertext,enabled_at,pending_expires_at "
                "FROM v2_mfa_credentials WHERE user_id=$1 FOR UPDATE", user["id"],
            )
            if (row is None or row["enabled_at"] is not None or
                    row["pending_expires_at"] is None or
                    row["pending_expires_at"].timestamp() <= time.time()):
                raise HTTPException(status_code=409, detail="Préparation expirée. Recommencez.")
            secret = decrypt_seed(row["secret_ciphertext"])
            step = int(time.time()) // 30
            matched = next((candidate for candidate in (step - 1, step, step + 1)
                            if hmac.compare_digest(pyotp.TOTP(secret).at(candidate * 30),
                                                   payload.code)), None)
            if matched is None:
                raise HTTPException(status_code=401, detail="Code de validation incorrect.")
            codes = new_recovery_codes()
            await connection.execute(
                "UPDATE v2_mfa_credentials SET enabled_at=now(),pending_expires_at=NULL,"
                "last_step=$1 WHERE user_id=$2", matched, user["id"],
            )
            await connection.executemany(
                "INSERT INTO v2_mfa_recovery_codes(user_id,code_hash) VALUES($1,$2)",
                [(user["id"], recovery_hash(code)) for code in codes],
            )
            # A prior session created before enabling 2FA must not remain a
            # long-lived bypass. Keep only the session currently enrolling.
            await connection.execute(
                "DELETE FROM v2_sessions WHERE user_id=$1 AND token_hash<>$2",
                user["id"], _token_hash(request.cookies["pc_v2_session"]),
            )
            await connection.execute(
                "UPDATE v2_api_tokens SET revoked_at=now() WHERE user_id=$1 "
                "AND revoked_at IS NULL", user["id"],
            )
        return {"recovery_codes": codes}
    finally:
        await connection.close()


@router.post("/mfa/recovery-codes", summary="Régénérer les codes de secours")
async def regenerate_codes(proof: SecondFactorProof, request: Request, response: Response):
    _secure_write(request)
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        await _rate_limit(connection, request, user["id"])
        async with connection.transaction():
            if not await connection.fetchval(
                "SELECT enabled_at IS NOT NULL FROM v2_mfa_credentials WHERE user_id=$1",
                user["id"],
            ):
                raise HTTPException(status_code=409, detail="Double authentification inactive.")
            await _full_proof(connection, user["id"], proof)
            codes = new_recovery_codes()
            await connection.execute("DELETE FROM v2_mfa_recovery_codes WHERE user_id=$1", user["id"])
            await connection.executemany(
                "INSERT INTO v2_mfa_recovery_codes(user_id,code_hash) VALUES($1,$2)",
                [(user["id"], recovery_hash(code)) for code in codes],
            )
        return {"recovery_codes": codes}
    finally:
        await connection.close()


@router.post("/mfa/disable", status_code=204, summary="Désactiver la double authentification")
async def mfa_disable(proof: SecondFactorProof, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        await _rate_limit(connection, request, user["id"])
        async with connection.transaction():
            if not await connection.fetchval(
                "SELECT enabled_at IS NOT NULL FROM v2_mfa_credentials WHERE user_id=$1",
                user["id"],
            ):
                raise HTTPException(status_code=409, detail="Double authentification inactive.")
            await _full_proof(connection, user["id"], proof)
            await connection.execute("DELETE FROM v2_mfa_credentials WHERE user_id=$1", user["id"])
            await connection.execute("DELETE FROM v2_mfa_recovery_codes WHERE user_id=$1", user["id"])
            await connection.execute(
                "UPDATE v2_api_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
                user["id"],
            )
    finally:
        await connection.close()


@router.get("/tokens", summary="Lister les jetons API personnels")
async def list_tokens(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        rows = await connection.fetch(
            "SELECT id,label,scope,created_at,expires_at,last_used_at "
            "FROM v2_api_tokens WHERE user_id=$1 AND revoked_at IS NULL "
            "AND expires_at>now() ORDER BY created_at DESC", user["id"],
        )
        return [dict(row) for row in rows]
    finally:
        await connection.close()


@router.post("/tokens", status_code=201, summary="Créer un jeton API personnel")
async def create_token(payload: TokenCreation, request: Request, response: Response):
    _secure_write(request)
    response.headers["Cache-Control"] = "no-store"
    label = payload.label.strip()
    if not label:
        raise HTTPException(status_code=422, detail="Indiquez un nom pour le jeton.")
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        await _rate_limit(connection, request, user["id"])
        async with connection.transaction():
            await _full_proof(connection, user["id"], payload)
            count = await connection.fetchval(
                "SELECT count(*) FROM v2_api_tokens WHERE user_id=$1 AND revoked_at IS NULL "
                "AND expires_at>now()", user["id"],
            )
            if count >= 10:
                raise HTTPException(status_code=409, detail="Limite de dix jetons actifs atteinte.")
            token = "pcv2_" + secrets.token_urlsafe(32)
            row = await connection.fetchrow(
                "INSERT INTO v2_api_tokens(user_id,label,token_hash,scope,expires_at) "
                "VALUES($1,$2,$3,$4,now()+$5::interval) "
                "RETURNING id,label,scope,created_at,expires_at",
                user["id"], label, _token_hash(token), payload.scope,
                timedelta(days=payload.expires_in_days),
            )
        return {**dict(row), "token": token}
    finally:
        await connection.close()


@router.delete("/tokens/{token_id}", status_code=204, summary="Révoquer un jeton API personnel")
async def revoke_token(token_id: int, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _session_user(connection, request)
        changed = await connection.fetchval(
            "UPDATE v2_api_tokens SET revoked_at=now() WHERE id=$1 AND user_id=$2 "
            "AND revoked_at IS NULL RETURNING id", token_id, user["id"],
        )
        if changed is None:
            raise HTTPException(status_code=404, detail="Jeton introuvable.")
    finally:
        await connection.close()
