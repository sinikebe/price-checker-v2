"""First-run PostgreSQL setup for the application."""

from __future__ import annotations

import json
import os
import re
import secrets
import ssl
import tempfile
from ipaddress import IPv6Address, ip_address
from pathlib import Path
from urllib.parse import urlsplit

import asyncpg
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, SecretStr

from app.core.config import get_settings
from app.db.v2_migrations import migrate_v2

router = APIRouter(prefix="/api/v2/setup", tags=["v2-setup"])

_PROJECT_HOST = re.compile(r"([a-z0-9]+)\.supabase\.co")
_POOLER_HOST = re.compile(r"[a-z0-9-]+\.pooler\.supabase\.com")
_POSTGRES_HOST = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9.-]*")
_DATABASE_NAME = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]*")
_USERNAME = re.compile(r"[a-zA-Z_][a-zA-Z0-9_.-]*")
_HOST_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")


class AccessRequest(BaseModel):
    access_code: SecretStr


class DatabaseRequest(AccessRequest):
    provider: str
    project_url: str = ""
    host: str
    port: int = 5432
    database: str
    username: str
    password: SecretStr = SecretStr("")
    tls_mode: str = "verify-full"
    public_hostname: str | None = None


class HostnameRequest(BaseModel):
    public_hostname: str
    expected_hostname: str


def _state_dir() -> Path:
    override = os.getenv("PRICE_CHECKER_V2_STATE_DIR")
    if override:
        return Path(override)
    return (
        Path.home()
        / ".local"
        / "state"
        / "price-checker"
        / get_settings().APP_ENV
        / "v2"
    )


def _ensure_state_dir() -> Path:
    directory = _state_dir()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    return directory


def _access_code() -> str:
    directory = _ensure_state_dir()
    path = directory / "access-code"
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        code = secrets.token_urlsafe(32)
        descriptor, temporary_name = tempfile.mkstemp(prefix=".access-", dir=directory)
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(code)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                os.link(temporary, path)
            except FileExistsError:
                return path.read_text(encoding="utf-8").strip()
            return code
        finally:
            temporary.unlink(missing_ok=True)


def _require_access(code: SecretStr) -> None:
    expected = _access_code()
    if not expected or not secrets.compare_digest(
        code.get_secret_value().encode("utf-8"), expected.encode("utf-8")
    ):
        raise HTTPException(status_code=403, detail="Code administrateur incorrect.")


def _read_config() -> dict | None:
    path = _state_dir() / "database.json"
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=503, detail="Configuration V2 illisible."
        ) from exc
    required = {
        "provider",
        "project_url",
        "host",
        "port",
        "database",
        "username",
        "password",
        "tls_mode",
    }
    if not isinstance(config, dict) or not required.issubset(config):
        raise HTTPException(status_code=503, detail="Configuration V2 illisible.")
    return config


def _valid_postgres_host(host: str) -> bool:
    if _POSTGRES_HOST.fullmatch(host):
        return True
    try:
        return isinstance(ip_address(host), IPv6Address)
    except ValueError:
        return False


def _project_ref(project_url: str) -> str:
    try:
        url = urlsplit(project_url.strip())
        hostname = (url.hostname or "").lower()
        valid_port = url.port is None
    except ValueError as exc:
        raise HTTPException(
            status_code=422, detail="URL de projet Supabase invalide."
        ) from exc
    match = _PROJECT_HOST.fullmatch(hostname)
    if (
        url.scheme != "https"
        or not match
        or url.username
        or url.password
        or not valid_port
        or url.path not in ("", "/")
        or url.query
        or url.fragment
    ):
        raise HTTPException(
            status_code=422,
            detail="Indiquez l’URL du projet Supabase (https://…supabase.co).",
        )
    return match.group(1)


def _validated_hostname(value: str, *, allow_local: bool = False) -> str:
    hostname = value.strip().lower()
    if allow_local:
        try:
            return str(ip_address(hostname))
        except ValueError:
            pass
    labels = hostname.split(".")
    if (
        not hostname
        or len(hostname) > 253
        or (len(labels) < 2 and not allow_local)
        or any(not _HOST_LABEL.fullmatch(label) for label in labels)
        or labels[-1].isdigit()
    ):
        raise HTTPException(
            status_code=422,
            detail="Nom d’hôte invalide : sans https://, port ni chemin.",
        )
    return hostname


def _validated_config(request: DatabaseRequest, previous: dict | None) -> dict:
    provider = request.provider.strip().lower()
    host = request.host.strip().lower()
    database = request.database.strip()
    username = request.username.strip()
    if not _DATABASE_NAME.fullmatch(database) or not _USERNAME.fullmatch(username):
        raise HTTPException(
            status_code=422, detail="Nom de base ou utilisateur invalide."
        )
    if not 1 <= request.port <= 65535:
        raise HTTPException(status_code=422, detail="Port PostgreSQL invalide.")

    if provider == "supabase":
        project_ref = _project_ref(request.project_url)
        if not _POOLER_HOST.fullmatch(host) or request.port != 5432:
            raise HTTPException(
                status_code=422,
                detail="Utilisez l’hôte du pooler Session Supabase, port 5432.",
            )
        if username != f"postgres.{project_ref}":
            raise HTTPException(
                status_code=422,
                detail="L’utilisateur du pooler ne correspond pas au projet.",
            )
        if request.tls_mode != "verify-full":
            raise HTTPException(
                status_code=422, detail="TLS vérifié est requis pour Supabase."
            )
        project_url = f"https://{project_ref}.supabase.co"
    elif provider == "postgres":
        if not _valid_postgres_host(host):
            raise HTTPException(status_code=422, detail="Hôte PostgreSQL invalide.")
        if request.tls_mode not in {"disable", "require", "verify-full"}:
            raise HTTPException(status_code=422, detail="Mode TLS invalide.")
        if request.tls_mode == "disable" and (
            get_settings().APP_ENV != "dev"
            or host not in {"localhost", "127.0.0.1", "::1"}
        ):
            raise HTTPException(
                status_code=422,
                detail="Sans TLS est réservé au PostgreSQL local de développement.",
            )
        project_url = ""
    else:
        raise HTTPException(status_code=422, detail="Type de base non pris en charge.")

    password = request.password.get_secret_value()
    if not password and previous is not None and provider != previous["provider"]:
        raise HTTPException(
            status_code=422,
            detail="Saisissez le mot de passe pour changer de fournisseur.",
        )
    if not password and previous is not None:
        password = str(previous["password"])
    if not password:
        raise HTTPException(
            status_code=422, detail="Le mot de passe PostgreSQL est requis."
        )
    hostname = (previous or {}).get("public_hostname", "")
    if request.public_hostname is not None:
        hostname = (
            _validated_hostname(
                request.public_hostname, allow_local=get_settings().APP_ENV == "dev"
            )
            if request.public_hostname.strip()
            else ""
        )
    if get_settings().APP_ENV != "dev" and not hostname and previous is None:
        raise HTTPException(
            status_code=422, detail="Un nom d’hôte est requis en production."
        )
    return {
        "public_hostname": hostname,
        "provider": provider,
        "project_url": project_url,
        "host": host,
        "port": request.port,
        "database": database,
        "username": username,
        "password": password,
        "tls_mode": request.tls_mode,
    }


async def _test_connection(config: dict) -> None:
    tls_mode = config["tls_mode"]
    ssl_option = (
        False
        if tls_mode == "disable"
        else ssl.create_default_context()
        if tls_mode == "verify-full"
        else "require"
    )
    connection = None
    try:
        connection = await asyncpg.connect(
            host=config["host"],
            port=config["port"],
            user=config["username"],
            password=config["password"],
            database=config["database"],
            ssl=ssl_option,
            timeout=8,
        )
        await connection.fetchval("SELECT 1")
    except Exception as exc:
        # Never echo driver errors: they can include connection information.
        raise HTTPException(
            status_code=400,
            detail="Connexion impossible. Vérifiez les paramètres PostgreSQL.",
        ) from exc
    finally:
        if connection is not None:
            await connection.close()


def _save_config(config: dict, *, first_setup: bool) -> None:
    directory = _ensure_state_dir()
    path = directory / "database.json"
    descriptor, temporary_name = tempfile.mkstemp(prefix=".database-", dir=directory)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(config, stream)
            stream.flush()
            os.fsync(stream.fileno())
        if first_setup:
            try:
                os.link(temporary, path)
            except FileExistsError as exc:
                raise HTTPException(
                    status_code=409, detail="La V2 est déjà configurée."
                ) from exc
        else:
            os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _public_config(config: dict) -> dict:
    return {key: value for key, value in config.items() if key != "password"}


def _require_secure_transport(request: Request) -> None:
    if get_settings().APP_ENV != "dev" and request.url.scheme != "https":
        raise HTTPException(
            status_code=403,
            detail="HTTPS est requis pour configurer la base V2.",
        )


@router.get("/status")
async def status():
    _access_code()
    return {"configured": _read_config() is not None, "app_env": get_settings().APP_ENV}


async def _require_setup_admin_if_initialized(request: Request) -> None:
    """Keep the installation code for bootstrap; require admin after bootstrap."""
    if _read_config() is None:
        return
    from app.api.v2.auth import _connect, _current_user

    connection = await _connect()
    try:
        admin_id = await connection.fetchval(
            "SELECT admin_user_id FROM v2_installation WHERE singleton=true"
        )
        if admin_id is not None:
            user = await _current_user(connection, request)
            if user is None or user["role"] != "admin":
                raise HTTPException(
                    status_code=403, detail="Accès administrateur requis."
                )
    finally:
        await connection.close()


@router.post("/database/details")
async def database_details(request: AccessRequest, transport: Request):
    from app.api.v2.auth import _secure_write

    _secure_write(transport)
    _require_access(request.access_code)
    await _require_setup_admin_if_initialized(transport)
    config = _read_config()
    if config is None:
        raise HTTPException(
            status_code=404, detail="La V2 n’est pas encore configurée."
        )
    return _public_config(config)


@router.post("/database/test")
async def test_database(request: DatabaseRequest, transport: Request):
    from app.api.v2.auth import _secure_write

    _secure_write(transport)
    _require_access(request.access_code)
    await _require_setup_admin_if_initialized(transport)
    config = _validated_config(request, _read_config())
    await _test_connection(config)
    return {"connected": True}


async def _migrate_schema(config: dict) -> None:
    try:
        await migrate_v2(config)
    except (asyncpg.PostgresError, OSError, TimeoutError) as exc:
        raise HTTPException(
            status_code=400,
            detail="Impossible de préparer le schéma de comptes V2.",
        ) from exc


@router.post("/database", status_code=201)
async def create_database(request: DatabaseRequest, transport: Request):
    from app.api.v2.auth import _secure_write

    _secure_write(transport)
    _require_access(request.access_code)
    await _require_setup_admin_if_initialized(transport)
    if _read_config() is not None:
        raise HTTPException(status_code=409, detail="La V2 est déjà configurée.")
    config = _validated_config(request, None)
    await _test_connection(config)
    await _migrate_schema(config)
    _save_config(config, first_setup=True)
    return {"configured": True}


@router.put("/database")
async def update_database(request: DatabaseRequest, transport: Request):
    from app.api.v2.auth import _secure_write

    _secure_write(transport)
    _require_access(request.access_code)
    await _require_setup_admin_if_initialized(transport)
    previous = _read_config()
    if previous is None:
        raise HTTPException(
            status_code=404, detail="La V2 n’est pas encore configurée."
        )
    config = _validated_config(request, previous)
    await _test_connection(config)
    await _migrate_schema(config)
    _save_config(config, first_setup=False)
    return {"configured": True}


async def _require_admin(request: Request) -> None:
    # Import lazily: auth uses the setup module for its database connection.
    from app.api.v2.auth import _connect, _current_user

    connection = await _connect()
    try:
        user = await _current_user(connection, request)
    finally:
        await connection.close()
    if user is None or user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Accès administrateur requis.")


@router.get("/hostname")
async def hostname_details(request: Request):
    await _require_admin(request)
    config = _read_config()
    if config is None:
        raise HTTPException(
            status_code=404, detail="La V2 n’est pas encore configurée."
        )
    return {"public_hostname": config.get("public_hostname", "")}


@router.put("/hostname")
async def update_hostname(payload: HostnameRequest, request: Request):
    from app.api.v2.auth import _secure_write

    _secure_write(request)
    await _require_admin(request)
    config = _read_config()
    if config is None:
        raise HTTPException(
            status_code=404, detail="La V2 n’est pas encore configurée."
        )
    if config.get("public_hostname", "") != payload.expected_hostname:
        raise HTTPException(
            status_code=409,
            detail=(
                "Le nom d’hôte a changé depuis l’ouverture de la page. "
                "Rechargez les paramètres."
            ),
        )
    if not payload.public_hostname.strip() and get_settings().APP_ENV != "dev":
        raise HTTPException(status_code=422, detail="Un nom d’hôte est requis en production.")
    config["public_hostname"] = (
        _validated_hostname(payload.public_hostname, allow_local=get_settings().APP_ENV == "dev")
        if payload.public_hostname.strip()
        else ""
    )
    _save_config(config, first_setup=False)
    return {"public_hostname": config["public_hostname"]}
