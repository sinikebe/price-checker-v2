"""Administrator-managed GitHub stores and connector installations."""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, SecretStr

from app.api.v2.auth import _connect, _secure_write
from app.api.v2.setup import _require_admin
from app.services.v2_connector_stores import (
    fetch_store, generate_key, key_path, load_installed, public_key,
    repository_url, save_key, store_dir, validate_catalog,
)

router = APIRouter(prefix="/api/v2/connector-stores", tags=["v2-connector-stores"])
logger = logging.getLogger(__name__)


class StoreCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    repository: str = Field(min_length=1, max_length=200)
    private: bool = False
    private_key: SecretStr | None = None


class KeyChange(BaseModel):
    private_key: SecretStr


class InstallationChange(BaseModel):
    action: Literal["install", "update", "rollback", "enable", "disable"]
    expected_commit: str | None = None
    expected_installed_commit: str | None = None


def _catalog(raw):
    return raw if isinstance(raw, list) else json.loads(raw)


async def _store(connection, store_id: int):
    row = await connection.fetchrow("SELECT * FROM v2_connector_stores WHERE id=$1", store_id)
    if not row:
        raise HTTPException(status_code=404, detail="Store introuvable.")
    return row


async def _list(connection):
    stores = await connection.fetch("SELECT * FROM v2_connector_stores ORDER BY id")
    installed = await connection.fetch("SELECT * FROM v2_connector_installations ORDER BY connector_id")
    by_store: dict[int, list[dict]] = {}
    for item in installed:
        by_store.setdefault(item["store_id"], []).append(dict(item))
    result = []
    for row in stores:
        result.append({"id": row["id"], "name": row["name"], "repository": row["repository"],
                       "private": row["private"], "has_key": key_path(row["id"]).is_file(),
                       "public_key": public_key(row["id"]) if row["private"] and key_path(row["id"]).is_file() else None,
                       "catalog": _catalog(row["catalog"]), "fetched_commit": row["fetched_commit"],
                       "fetched_at": row["fetched_at"], "installations": by_store.get(row["id"], [])})
    return {"stores": result}


@router.get("")
async def list_stores(request: Request):
    await _require_admin(request)
    connection = await _connect()
    try:
        return await _list(connection)
    finally:
        await connection.close()


@router.get("/versions")
async def installed_versions():
    connection = await _connect()
    try:
        rows = await connection.fetch(
            "SELECT store_id,connector_id,version,commit_sha,enabled "
            "FROM v2_connector_installations ORDER BY connector_id")
        items = []
        for row in rows:
            root = store_dir(row["store_id"]) / "revisions" / row["commit_sha"]
            try:
                item = next(part for part in validate_catalog(root)
                            if part["id"] == row["connector_id"])
            except (OSError, ValueError, StopIteration):
                continue
            items.append({"id": item["id"], "name": item["name"],
                          "version": row["version"], "enabled": row["enabled"],
                          "changelog": item["changelog"]})
        return {"connectors": items}
    finally:
        await connection.close()


@router.post("", status_code=201)
async def add_store(payload: StoreCreate, request: Request):
    _secure_write(request)
    await _require_admin(request)
    try:
        repository, _ = repository_url(payload.repository)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if payload.private_key and not payload.private:
        raise HTTPException(status_code=422, detail="Une clé SSH exige un store privé.")
    connection = await _connect()
    try:
        existing = await connection.fetchval("SELECT id FROM v2_connector_stores WHERE repository=$1", repository)
        if existing:
            raise HTTPException(status_code=409, detail="Ce dépôt est déjà ajouté.")
        store_id = await connection.fetchval(
            "INSERT INTO v2_connector_stores(name,repository,private) VALUES($1,$2,$3) RETURNING id",
            payload.name.strip(), repository, payload.private)
        if payload.private_key:
            try:
                await asyncio.to_thread(save_key, store_id, payload.private_key.get_secret_value())
            except ValueError as exc:
                await connection.execute("DELETE FROM v2_connector_stores WHERE id=$1", store_id)
                raise HTTPException(status_code=422, detail=str(exc)) from exc
        return await _list(connection)
    finally:
        await connection.close()


@router.put("/{store_id}/key")
async def set_key(store_id: int, payload: KeyChange, request: Request):
    _secure_write(request)
    await _require_admin(request)
    connection = await _connect()
    try:
        store = await _store(connection, store_id)
        if not store["private"]:
            raise HTTPException(status_code=422, detail="Ce store est public.")
        try:
            await asyncio.to_thread(save_key, store_id, payload.private_key.get_secret_value())
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return await _list(connection)
    finally:
        await connection.close()


@router.post("/{store_id}/key/generate")
async def create_key(store_id: int, request: Request):
    _secure_write(request)
    await _require_admin(request)
    connection = await _connect()
    try:
        store = await _store(connection, store_id)
        if not store["private"]:
            raise HTTPException(status_code=422, detail="Ce store est public.")
        if key_path(store_id).exists():
            raise HTTPException(status_code=409, detail="Une clé existe déjà ; utilisez l’import pour la remplacer.")
        await asyncio.to_thread(generate_key, store_id)
        return await _list(connection)
    finally:
        await connection.close()


@router.post("/{store_id}/refresh")
async def refresh_store(store_id: int, request: Request):
    _secure_write(request)
    await _require_admin(request)
    connection = await _connect()
    try:
        store = await _store(connection, store_id)
        try:
            commit, catalog = await fetch_store(store_id, store["repository"], store["private"])
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        await connection.execute(
            "UPDATE v2_connector_stores SET catalog=$1::jsonb,fetched_commit=$2,fetched_at=now() WHERE id=$3",
            json.dumps(catalog), commit, store_id)
        return await _list(connection)
    finally:
        await connection.close()


@router.put("/{store_id}/connectors/{connector_id}")
async def change_installation(store_id: int, connector_id: str, payload: InstallationChange, request: Request):
    _secure_write(request)
    await _require_admin(request)
    connection = await _connect()
    try:
        async with connection.transaction():
            store = await connection.fetchrow("SELECT * FROM v2_connector_stores WHERE id=$1 FOR UPDATE", store_id)
            if not store:
                raise HTTPException(status_code=404, detail="Store introuvable.")
            current = await connection.fetchrow(
                "SELECT * FROM v2_connector_installations WHERE connector_id=$1 FOR UPDATE", connector_id)
            if current and current["store_id"] != store_id:
                raise HTTPException(status_code=409, detail="Connecteur déjà installé depuis un autre store.")
            if payload.expected_installed_commit != (current["commit_sha"] if current else None):
                raise HTTPException(status_code=409, detail="Installation modifiée ; actualisez la page.")
            if payload.action in ("install", "update"):
                if payload.expected_commit != store["fetched_commit"] or not payload.expected_commit:
                    raise HTTPException(status_code=409, detail="Catalogue modifié ; actualisez le store.")
                item = next((part for part in _catalog(store["catalog"]) if part["id"] == connector_id), None)
                if item is None:
                    raise HTTPException(status_code=404, detail="Connecteur absent du catalogue.")
                if payload.action == "install" and current or payload.action == "update" and not current:
                    raise HTTPException(status_code=409, detail="État d’installation inattendu.")
                if current and tuple(map(int, item["version"].split("."))) <= tuple(map(int, current["version"].split("."))):
                    raise HTTPException(status_code=409, detail="Une mise à jour exige une version de connecteur supérieure.")
                try:
                    module = await asyncio.to_thread(load_installed, store_id, connector_id, store["fetched_commit"])
                except (FileNotFoundError, ImportError, ValueError, OSError) as exc:
                    logger.warning("Connector validation failed: %s", type(exc).__name__)
                    raise HTTPException(status_code=422, detail="Code du connecteur incompatible ou introuvable.") from exc
                setup = getattr(module, "setup", None)
                if setup is not None:
                    if not callable(setup):
                        raise HTTPException(status_code=422, detail="Initialisation du connecteur invalide.")
                    await setup(connection)
                if current:
                    await connection.execute(
                        "UPDATE v2_connector_installations SET version=$1,commit_sha=$2,"
                        "previous_version=$3,previous_commit=$4,updated_at=now() "
                        "WHERE connector_id=$5", item["version"], store["fetched_commit"],
                        current["version"], current["commit_sha"], connector_id)
                else:
                    await connection.execute(
                        "INSERT INTO v2_connector_installations(connector_id,store_id,version,commit_sha) "
                        "VALUES($1,$2,$3,$4)", connector_id, store_id, item["version"], store["fetched_commit"])
            elif payload.action == "rollback":
                if not current or not current["previous_commit"]:
                    raise HTTPException(status_code=409, detail="Aucune version précédente disponible.")
                try:
                    await asyncio.to_thread(load_installed, store_id, connector_id, current["previous_commit"])
                except (FileNotFoundError, ImportError, ValueError, OSError) as exc:
                    raise HTTPException(status_code=422, detail="Version précédente indisponible.") from exc
                await connection.execute(
                    "UPDATE v2_connector_installations SET version=$1,commit_sha=$2,"
                    "previous_version=$3,previous_commit=$4,updated_at=now() WHERE connector_id=$5",
                    current["previous_version"], current["previous_commit"], current["version"],
                    current["commit_sha"], connector_id)
            elif payload.action in ("enable", "disable"):
                if not current:
                    raise HTTPException(status_code=404, detail="Connecteur non installé.")
                await connection.execute(
                    "UPDATE v2_connector_installations SET enabled=$1,updated_at=now() WHERE connector_id=$2",
                    payload.action == "enable", connector_id)
        return await _list(connection)
    finally:
        await connection.close()


@router.delete("/{store_id}/connectors/{connector_id}")
async def remove_installation(store_id: int, connector_id: str, request: Request):
    _secure_write(request)
    await _require_admin(request)
    connection = await _connect()
    try:
        deleted = await connection.fetchval(
            "DELETE FROM v2_connector_installations WHERE store_id=$1 AND connector_id=$2 RETURNING connector_id",
            store_id, connector_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Installation introuvable.")
        return await _list(connection)
    finally:
        await connection.close()


@router.delete("/{store_id}")
async def remove_store(store_id: int, request: Request):
    _secure_write(request)
    await _require_admin(request)
    connection = await _connect()
    try:
        await _store(connection, store_id)
        await connection.execute("DELETE FROM v2_connector_stores WHERE id=$1", store_id)
        await asyncio.to_thread(shutil.rmtree, store_dir(store_id), ignore_errors=True)
        return await _list(connection)
    finally:
        await connection.close()


async def enqueue_installed(connection, connector_id: str, product_id: int) -> str:
    row = await connection.fetchrow(
        "SELECT store_id,commit_sha FROM v2_connector_installations WHERE connector_id=$1 AND enabled",
        connector_id)
    if not row:
        return "disabled"
    try:
        module = load_installed(row["store_id"], connector_id, row["commit_sha"])
        return await module.enqueue(connection, product_id)
    except (FileNotFoundError, ImportError, ValueError, OSError):
        logger.exception("Connector %s unavailable", connector_id)
        return "unavailable"


@router.post("/{connector_id}/products/{product_id}/refresh")
async def request_connector_refresh(connector_id: str, product_id: int, request: Request):
    _secure_write(request)
    if product_id <= 0:
        raise HTTPException(status_code=422, detail="Produit invalide.")
    connection = await _connect()
    try:
        return {"status": await enqueue_installed(connection, connector_id, product_id)}
    finally:
        await connection.close()


async def connector_worker() -> None:
    while True:
        try:
            connection = await _connect()
            try:
                rows = await connection.fetch(
                    "SELECT store_id,connector_id,commit_sha FROM v2_connector_installations WHERE enabled")
            finally:
                await connection.close()
            for row in rows:
                try:
                    module = load_installed(row["store_id"], row["connector_id"], row["commit_sha"])
                    await module.process_one()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("Connector %s worker deferred", row["connector_id"])
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Connector worker deferred")
        await asyncio.sleep(15)
