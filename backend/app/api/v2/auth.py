"""Account bootstrap and cookie sessions for the public API."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import re
import secrets
from datetime import timedelta
from urllib.parse import urlsplit

import asyncpg
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, SecretStr

from app.api.v2.setup import (
    _access_code,
    _read_config,
    _require_access,
    _require_secure_transport,
)
from app.core.config import get_settings
from app.services.v2_db_pool import acquire_v2

router = APIRouter(prefix="/api/v2/auth", tags=["v2-auth"])

_COOKIE_NAME = "pc_v2_session"
_SESSION_SECONDS = 7 * 24 * 60 * 60
_LOGIN_ORIGIN_MAX = 30
_USERNAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{2,31}")
_SESSION_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
_HASHER = PasswordHasher()
_DUMMY_HASH = _HASHER.hash("not-a-real-account-password")


class Credentials(BaseModel):
    username: str
    password: SecretStr


class AdminCredentials(BaseModel):
    access_code: SecretStr
    password: SecretStr


def _username(value: str) -> tuple[str, str]:
    display = value.strip()
    if not _USERNAME.fullmatch(display):
        raise HTTPException(
            status_code=422,
            detail=(
                "Le pseudo doit contenir 3 à 32 caractères : lettres, chiffres, "
                "point, tiret ou underscore."
            ),
        )
    return display, display.casefold()


def _password(value: SecretStr, *, min_length: int = 12) -> str:
    password = value.get_secret_value()
    if len(password) < min_length:
        raise HTTPException(
            status_code=422,
            detail=f"Le mot de passe doit contenir au moins {min_length} caractères.",
        )
    if len(password.encode("utf-8")) > 1024:
        raise HTTPException(status_code=422, detail="Le mot de passe est trop long.")
    return password


def _check_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(status_code=403, detail="Origine non autorisée.")
    if not origin:
        return
    parsed = urlsplit(origin)
    if (parsed.scheme, parsed.netloc) != (request.url.scheme, request.url.netloc):
        raise HTTPException(status_code=403, detail="Origine non autorisée.")


def _secure_write(request: Request) -> None:
    _require_secure_transport(request)
    _check_origin(request)


def _public_user(row: asyncpg.Record | None) -> dict | None:
    if row is None:
        return None
    return {"id": row["id"], "username": row["username"], "role": row["role"]}


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def _limit_key(kind: str, request: Request, username_key: str = "") -> str:
    # The installation code is a random secret stored outside PostgreSQL.
    # A plain hash of an IP can be guessed offline from the small IP space.
    remote = request.client.host if request.client else "unknown"
    message = f"{kind}:{remote}:{username_key}".encode()
    return hmac.new(_access_code().encode(), message, hashlib.sha256).hexdigest()


async def _limit_reached(
    connection: asyncpg.Connection, key: str, seconds: int, max_attempts: int
) -> bool:
    count = await connection.fetchval(
        """
        SELECT attempts FROM v2_auth_limits
        WHERE key=$1 AND window_started_at > now() - ($2 * interval '1 second')
        """,
        key,
        seconds,
    )
    return count is not None and count >= max_attempts


async def _bump_limit(connection: asyncpg.Connection, key: str, seconds: int) -> int:
    return await connection.fetchval(
        """
        INSERT INTO v2_auth_limits(key, attempts) VALUES($1, 1)
        ON CONFLICT(key) DO UPDATE SET
            attempts = CASE
                WHEN v2_auth_limits.window_started_at
                     < now() - ($2 * interval '1 second')
                THEN 1 ELSE v2_auth_limits.attempts + 1 END,
            window_started_at = CASE
                WHEN v2_auth_limits.window_started_at
                     < now() - ($2 * interval '1 second')
                THEN now() ELSE v2_auth_limits.window_started_at END
        RETURNING attempts
        """,
        key,
        seconds,
    )


async def _purge_expired_limits(connection: asyncpg.Connection) -> None:
    # Registration has the longest window (one hour).
    await connection.execute(
        "DELETE FROM v2_auth_limits WHERE window_started_at < now() - interval '1 hour'"
    )


async def _connect():
    config = _read_config()
    if config is None:
        raise HTTPException(status_code=503, detail="Configurez d'abord la base V2.")
    try:
        return await acquire_v2(config)
    except (OSError, TimeoutError, asyncpg.PostgresError) as exc:
        raise HTTPException(status_code=503, detail="Base V2 indisponible.") from exc


async def _current_user(
    connection: asyncpg.Connection, request: Request
) -> dict | None:
    token = request.cookies.get(_COOKIE_NAME)
    if not token or not _SESSION_TOKEN.fullmatch(token):
        return None
    row = await connection.fetchrow(
        """
        SELECT u.id, u.username, u.role FROM v2_sessions s
        JOIN v2_users u ON u.id = s.user_id
        WHERE s.token_hash=$1 AND s.expires_at > now()
        """,
        _token_hash(token),
    )
    return _public_user(row)


async def _issue_session(
    connection: asyncpg.Connection, response: Response, user_id: int
) -> None:
    await connection.execute("DELETE FROM v2_sessions WHERE expires_at <= now()")
    token = secrets.token_urlsafe(32)
    await connection.execute(
        """
        INSERT INTO v2_sessions(token_hash, user_id, expires_at)
        VALUES ($1, $2, now() + $3::interval)
        """,
        _token_hash(token),
        user_id,
        timedelta(seconds=_SESSION_SECONDS),
    )
    response.set_cookie(
        _COOKIE_NAME,
        token,
        max_age=_SESSION_SECONDS,
        path="/api/v2",
        httponly=True,
        secure=get_settings().APP_ENV != "dev",
        samesite="lax",
    )


async def _hash_password(password: str) -> str:
    return await asyncio.to_thread(_HASHER.hash, password)


async def _verify_password(encoded: str, password: str) -> bool:
    try:
        return await asyncio.to_thread(_HASHER.verify, encoded, password)
    except (VerificationError, InvalidHashError):
        return False


@router.get("/status")
async def status(request: Request):
    connection = await _connect()
    try:
        row = await connection.fetchrow(
            "SELECT admin_user_id FROM v2_installation WHERE singleton=true"
        )
        if row is None:
            raise HTTPException(status_code=503, detail="Schéma V2 incomplet.")
        return {
            "admin_initialized": row["admin_user_id"] is not None,
            "user": await _current_user(connection, request),
        }
    except asyncpg.UndefinedTableError as exc:
        raise HTTPException(status_code=503, detail="Migrez la base V2.") from exc
    finally:
        await connection.close()


@router.post("/admin", status_code=201)
async def create_admin(
    credentials: AdminCredentials, request: Request, response: Response
):
    _secure_write(request)
    _require_access(credentials.access_code)
    admin_min_length = 8 if get_settings().APP_ENV == "dev" else 12
    password_hash = await _hash_password(
        _password(credentials.password, min_length=admin_min_length)
    )
    connection = await _connect()
    try:
        async with connection.transaction():
            row = await connection.fetchrow(
                "SELECT admin_user_id FROM v2_installation "
                "WHERE singleton=true FOR UPDATE"
            )
            if row is None:
                raise HTTPException(status_code=503, detail="Schéma V2 incomplet.")
            if row["admin_user_id"] is not None:
                raise HTTPException(status_code=409, detail="Administrateur déjà créé.")
            user = await connection.fetchrow(
                """
                INSERT INTO v2_users(username, username_key, password_hash, role)
                VALUES('admin', 'admin', $1, 'admin') RETURNING id, username, role
                """,
                password_hash,
            )
            await connection.execute(
                "UPDATE v2_installation SET admin_user_id=$1 WHERE singleton=true",
                user["id"],
            )
            await _issue_session(connection, response, user["id"])
            return _public_user(user)
    finally:
        await connection.close()


@router.post("/register", status_code=201)
async def register(credentials: Credentials, request: Request, response: Response):
    _secure_write(request)
    username, username_key = _username(credentials.username)
    if username_key == "admin":
        raise HTTPException(status_code=409, detail="Ce pseudo est indisponible.")
    password = _password(credentials.password)
    connection = await _connect()
    try:
        initialized = await connection.fetchval(
            "SELECT admin_user_id IS NOT NULL FROM v2_installation WHERE singleton=true"
        )
        if not initialized:
            raise HTTPException(status_code=403, detail="Installation incomplète.")
        await _purge_expired_limits(connection)
        key = _limit_key("register", request)
        if await _bump_limit(connection, key, 3600) > 5:
            raise HTTPException(
                status_code=429, detail="Trop d'inscriptions. Réessayez plus tard."
            )
        password_hash = await _hash_password(password)
        try:
            user = await connection.fetchrow(
                """
                INSERT INTO v2_users(username, username_key, password_hash, role)
                VALUES($1, $2, $3, 'visitor') RETURNING id, username, role
                """,
                username,
                username_key,
                password_hash,
            )
        except asyncpg.UniqueViolationError as exc:
            raise HTTPException(
                status_code=409, detail="Ce pseudo est déjà utilisé."
            ) from exc
        await _issue_session(connection, response, user["id"])
        return _public_user(user)
    finally:
        await connection.close()


@router.post("/login")
async def login(credentials: Credentials, request: Request, response: Response):
    _secure_write(request)
    _, username_key = _username(credentials.username)
    password = credentials.password.get_secret_value()
    if len(password.encode("utf-8")) > 1024:
        raise HTTPException(status_code=401, detail="Identifiants incorrects.")
    connection = await _connect()
    try:
        await _purge_expired_limits(connection)
        # Count all attempts by origin before running the expensive Argon2 check.
        # This caps novel-username attempts as well as repeated attempts for one account.
        origin_key = _limit_key("login-origin", request)
        if await _bump_limit(connection, origin_key, 900) > _LOGIN_ORIGIN_MAX:
            raise HTTPException(
                status_code=429, detail="Trop de tentatives. Réessayez plus tard."
            )
        key = _limit_key("login", request, username_key)
        if await _limit_reached(connection, key, 900, 10):
            raise HTTPException(
                status_code=429, detail="Trop de tentatives. Réessayez plus tard."
            )
        user = await connection.fetchrow(
            """
            SELECT id, username, role, password_hash FROM v2_users
            WHERE username_key=$1
            """,
            username_key,
        )
        verified = await _verify_password(
            user["password_hash"] if user else _DUMMY_HASH, password
        )
        if not user or not verified:
            await _bump_limit(connection, key, 900)
            raise HTTPException(status_code=401, detail="Identifiants incorrects.")
        await connection.execute("DELETE FROM v2_auth_limits WHERE key=$1", key)
        if _HASHER.check_needs_rehash(user["password_hash"]):
            await connection.execute(
                "UPDATE v2_users SET password_hash=$1 WHERE id=$2",
                await _hash_password(password),
                user["id"],
            )
        await _issue_session(connection, response, user["id"])
        return _public_user(user)
    finally:
        await connection.close()


@router.post("/logout", status_code=204)
async def logout(request: Request, response: Response):
    _secure_write(request)
    token = request.cookies.get(_COOKIE_NAME)
    if token and _SESSION_TOKEN.fullmatch(token):
        connection = await _connect()
        try:
            await connection.execute(
                "DELETE FROM v2_sessions WHERE token_hash=$1", _token_hash(token)
            )
        finally:
            await connection.close()
    response.delete_cookie(_COOKIE_NAME, path="/api/v2")
