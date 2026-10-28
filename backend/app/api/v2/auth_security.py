"""Small, server-side primitives for account second factors and API tokens."""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import time

import asyncpg
import pyotp
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException

from app.api.v2.setup import _access_code

_TOKEN_PATTERN = re.compile(r"pcv2_[A-Za-z0-9_-]{43}")
_RECOVERY_PATTERN = re.compile(r"[0-9a-fA-F]{32}")


def _cipher() -> Fernet:
    # The installation secret is generated outside PostgreSQL and retained in
    # the host's private state directory. Database-only backups cannot expose
    # the TOTP seeds; restoring an instance must also preserve access-code.
    key = hmac.new(
        _access_code().encode("utf-8"), b"price-checker-v2/totp-encryption/v1",
        hashlib.sha256,
    ).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def account_limit_key(kind: str, user_id: int) -> str:
    return hmac.new(
        _access_code().encode("utf-8"), f"{kind}:{user_id}".encode("ascii"),
        hashlib.sha256,
    ).hexdigest()


def encrypt_seed(seed: str) -> str:
    return _cipher().encrypt(seed.encode("ascii")).decode("ascii")


def decrypt_seed(ciphertext: str) -> str:
    try:
        return _cipher().decrypt(ciphertext.encode("ascii")).decode("ascii")
    except (InvalidToken, ValueError) as exc:
        raise HTTPException(status_code=503, detail="Clé de double authentification indisponible.") from exc


def new_recovery_codes() -> list[str]:
    return [secrets.token_hex(16) for _ in range(8)]


def recovery_hash(code: str) -> str | None:
    normalized = code.replace("-", "").strip().lower()
    if not _RECOVERY_PATTERN.fullmatch(normalized):
        return None
    return hashlib.sha256(normalized.encode("ascii")).hexdigest()


async def verify_second_factor(
    connection: asyncpg.Connection, user_id: int, code: str | None,
    *, required: bool = False,
) -> bool:
    """Verify and consume a TOTP step or recovery code inside a transaction.

    Caller holds a transaction. FOR UPDATE serializes concurrent submissions,
    making both TOTP steps and recovery codes truly single-use.
    """
    row = await connection.fetchrow(
        "SELECT secret_ciphertext,enabled_at,last_step FROM v2_mfa_credentials "
        "WHERE user_id=$1 FOR UPDATE", user_id,
    )
    if row is None or row["enabled_at"] is None:
        return not required
    if code is None:
        return False
    value = code.strip()
    if re.fullmatch(r"[0-9]{6}", value):
        seed = decrypt_seed(row["secret_ciphertext"])
        totp = pyotp.TOTP(seed)
        current_step = int(time.time()) // 30
        for step in (current_step - 1, current_step, current_step + 1):
            if (step > (row["last_step"] or -1)
                    and hmac.compare_digest(totp.at(step * 30), value)):
                await connection.execute(
                    "UPDATE v2_mfa_credentials SET last_step=$1 WHERE user_id=$2",
                    step, user_id,
                )
                return True
    code_hash = recovery_hash(value)
    if code_hash is not None:
        return bool(await connection.fetchval(
            "DELETE FROM v2_mfa_recovery_codes WHERE user_id=$1 AND code_hash=$2 "
            "RETURNING code_hash", user_id, code_hash,
        ))
    return False
