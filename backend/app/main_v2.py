"""ASGI entrypoint for Price Checker V2."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from importlib.metadata import version as package_version

import asyncpg
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.routing import APIRoute

from app.api.v2.account_data import router as account_data_router
from app.api.v2.account_security import router as account_security_router
from app.api.v2.auth import _connect, purge_ephemeral_auth_data
from app.api.v2.auth import router as auth_router
from app.api.v2.basket import router as basket_router
from app.api.v2.catalogue import router as catalogue_router
from app.api.v2.connector_stores import router as connector_stores_router, connector_worker
from app.api.v2.duplicate_merges import router as duplicate_merges_router
from app.api.v2.host_health import router as host_health_router
from app.api.v2.legal import router as legal_router
from app.api.v2.moderation import router as moderation_router
from app.api.v2.prices import router as prices_router
from app.api.v2.products import router as products_router
from app.api.v2.recipe_submissions import router as recipe_submissions_router
from app.api.v2.recipes import router as recipes_router
from app.api.v2.server_cache import router as server_cache_router
from app.api.v2.setup import router as setup_router
from app.api.v2.stores import router as stores_router
from app.api.v2.sync import router as sync_router
from app.api.v2.transfers import router as transfers_router
from app.api.v2.updates import router as updates_router
from app.core.config import get_settings
from app.services.openfoodfacts_client import aclose_off_client
from app.services.v2_db_pool import close_v2_pool
from app.services.v2_off_refresh_queue import off_refresh_worker
from app.services.v2_open_prices_sync import open_prices_worker
from app.services.v2_private_retention import purge_private_data
from app.services.v2_trusted_proxy import TrustedWebProxyMiddleware


async def retention_worker():
    while True:
        try:
            connection = await _connect()
            try:
                await purge_ephemeral_auth_data(connection)
                await purge_private_data(connection)
            finally:
                await connection.close()
        except (HTTPException, OSError, TimeoutError, asyncpg.PostgresError):
            logging.getLogger(__name__).warning("V2 private-data cleanup deferred")
        await asyncio.sleep(3600)


@asynccontextmanager
async def lifespan(_: FastAPI):
    workers = [asyncio.create_task(off_refresh_worker()),
               asyncio.create_task(retention_worker()),
               asyncio.create_task(open_prices_worker()),
               asyncio.create_task(connector_worker())]
    try:
        yield
    finally:
        for worker in workers:
            worker.cancel()
        for worker in workers:
            with suppress(asyncio.CancelledError):
                await worker
        await aclose_off_client()
        await close_v2_pool()


app = FastAPI(
    title="Price Checker V2 API",
    version=package_version("price-checker-v2-backend"),
    description=(
        "API HTTP de Price Checker pour consulter les produits, magasins, prix et recettes, et soumettre des contributions. "
        "Certaines opérations nécessitent une connexion ou des droits d’administration. "
        "Pour les routes protégées, utilisez une session de navigateur ou un jeton personnel dans l’en-tête `Authorization: Bearer <jeton>`. Les jetons se créent dans Paramètres → Jetons API, avec une portée `read` (lecture) ou `contribute` (lecture et contribution). Ils expirent et peuvent être révoqués. Un jeton `read` peut aussi télécharger l’export des données privées de son propre compte ; ses secrets ne figurent pas dans cet export. Les opérations administrateur et la gestion des identifiants exigent une session de navigateur."
    ),
    openapi_url="/api/v2/openapi.json",
    docs_url="/api/v2/docs",
    redoc_url=None,
    swagger_ui_oauth2_redirect_url=None,
    lifespan=lifespan,
)
app.add_middleware(TrustedWebProxyMiddleware)
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=bool(settings.cors_origins),
    allow_methods=["*"],
    allow_headers=["*"],
)
ROUTERS = (
    setup_router,
    legal_router,
    moderation_router,
    duplicate_merges_router,
    auth_router,
    account_data_router,
    account_security_router,
    products_router,
    catalogue_router,
    basket_router,
    connector_stores_router,
    prices_router,
    stores_router,
    transfers_router,
    recipes_router,
    recipe_submissions_router,
    sync_router,
    updates_router,
    host_health_router,
    server_cache_router,
)

# These operations use _current_user (directly or through their user helper)
# and can act on a personal token. Credential management and admin-only
# operations are intentionally absent. Public reads may also be anonymous.
BEARER_OPERATIONS = {
    ("GET", "/api/v2/auth/status"),
    ("GET", "/api/v2/account/export"),
    ("GET", "/api/v2/sync/versions"),
    ("GET", "/api/v2/stores/matches"),
    ("GET", "/api/v2/stores/{store_id}"),
    ("POST", "/api/v2/stores/{store_id}/alias-proposals"),
    ("GET", "/api/v2/products/by-barcode/{barcode}"),
    ("GET", "/api/v2/products/drafts/mine"),
    ("GET", "/api/v2/products/drafts/{draft_id}"),
    ("POST", "/api/v2/products/drafts"),
    ("PUT", "/api/v2/products/drafts/{draft_id}"),
    ("DELETE", "/api/v2/products/drafts/{draft_id}"),
    ("GET", "/api/v2/products/{product_id}/off/refresh-status"),
    ("POST", "/api/v2/products/{product_id}/off/refresh"),
    ("GET", "/api/v2/prices/drafts/mine"),
    ("GET", "/api/v2/prices/products/{product_id}/drafts"),
    ("POST", "/api/v2/prices/capture-drafts"),
    ("POST", "/api/v2/prices/products/{product_id}/drafts"),
    ("POST", "/api/v2/prices/products/{product_id}/capture-drafts"),
    ("GET", "/api/v2/recipes/{recipe_id}/access"),
    ("POST", "/api/v2/recipes"),
    ("PUT", "/api/v2/recipes/{recipe_id}"),
    ("DELETE", "/api/v2/recipes/{recipe_id}"),
    ("GET", "/api/v2/recipes/submissions/mine"),
    ("GET", "/api/v2/recipes/submissions/{submission_id}"),
    ("PUT", "/api/v2/recipes/submissions/{submission_id}"),
    ("DELETE", "/api/v2/recipes/submissions/{submission_id}"),
    ("POST", "/api/v2/moderation/reports"),
}
OPTIONAL_BEARER_OPERATIONS = {
    ("GET", "/api/v2/auth/status"),
    ("GET", "/api/v2/sync/versions"),
    ("GET", "/api/v2/stores/matches"),
    ("GET", "/api/v2/stores/{store_id}"),
    ("GET", "/api/v2/products/by-barcode/{barcode}"),
}
for router in ROUTERS:
    for route in router.routes:
        if not isinstance(route, APIRoute) or not route.methods:
            continue
        operation = (next(iter(route.methods)), route.path)
        if operation not in BEARER_OPERATIONS:
            continue
        route.openapi_extra = {
            **(route.openapi_extra or {}),
            "security": ([{}, {"PersonalApiToken": []}]
                         if operation in OPTIONAL_BEARER_OPERATIONS
                         else [{"PersonalApiToken": []}]),
        }
for router in ROUTERS:
    app.include_router(router)


@app.get("/health", include_in_schema=False)
async def health():
    return {"status": "ok"}
