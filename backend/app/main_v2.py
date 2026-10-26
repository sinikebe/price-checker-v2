"""ASGI entrypoint for Price Checker V2."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v2.account_data import router as account_data_router
from app.api.v2.auth import router as auth_router
from app.api.v2.basket import router as basket_router
from app.api.v2.moderation import router as moderation_router
from app.api.v2.prices import router as prices_router
from app.api.v2.products import router as products_router
from app.api.v2.recipes import router as recipes_router
from app.api.v2.setup import router as setup_router
from app.api.v2.sync import router as sync_router
from app.api.v2.transfers import router as transfers_router
from app.api.v2.updates import router as updates_router
from app.core.config import get_settings
from app.services.openfoodfacts_client import aclose_off_client
from app.services.v2_db_pool import close_v2_pool
from app.services.v2_off_refresh_queue import off_refresh_worker
from app.services.v2_trusted_proxy import TrustedWebProxyMiddleware


@asynccontextmanager
async def lifespan(_: FastAPI):
    worker = asyncio.create_task(off_refresh_worker())
    try:
        yield
    finally:
        worker.cancel()
        with suppress(asyncio.CancelledError):
            await worker
        await aclose_off_client()
        await close_v2_pool()


app = FastAPI(title="Price Checker V2 API", lifespan=lifespan)
app.add_middleware(TrustedWebProxyMiddleware)
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=bool(settings.cors_origins),
    allow_methods=["*"],
    allow_headers=["*"],
)
for router in (
    setup_router,
    moderation_router,
    auth_router,
    account_data_router,
    products_router,
    prices_router,
    transfers_router,
    recipes_router,
    sync_router,
    basket_router,
    updates_router,
):
    app.include_router(router)


@app.get("/health")
async def health():
    return {"status": "ok"}
