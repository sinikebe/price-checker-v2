"""Open Food Facts search and exact lookup for the independent V2 catalogue."""

from __future__ import annotations

import logging
import time

import httpx
from fastapi import HTTPException

from app.core.config import get_settings
from app.schemas.openfoodfacts import (
    OpenFoodFactsSearchResponse,
    OpenFoodFactsSuggestion,
)
from app.services.off_rate_limit import OffRateLimited, retry_after_headers
from app.services.openfoodfacts_client import OFF_SEARCH_URL, off_json_get

logger = logging.getLogger(__name__)
_OFF_FIELDS = (
    "code,product_name,brands,quantity,ingredients_text,image_front_small_url,"
    "nutriscore_grade,nova_group,nutriscore_version"
)
_PRODUCT_URL = "https://world.openfoodfacts.org/api/v2/product"
_cache: dict[tuple[str, str], tuple[float, object]] = {}


def normalize_barcode(raw: str) -> str:
    value = raw.strip()
    if not value.isascii() or not value.isdigit() or len(value) not in {8, 12, 13, 14}:
        raise HTTPException(status_code=422, detail="Code-barres invalide.")
    return value


def _nutrition(product: dict) -> dict:
    raw_grade = product.get("nutriscore_grade")
    grade = raw_grade.strip().lower() if isinstance(raw_grade, str) else ""
    grade = grade if grade in "abcde" and len(grade) == 1 else None
    raw_nova = product.get("nova_group")
    try:
        nova = int(raw_nova) if not isinstance(raw_nova, bool) else None
    except (TypeError, ValueError):
        nova = None
    nova = nova if nova in {1, 2, 3, 4} else None
    raw_version = product.get("nutriscore_version")
    version = raw_version.strip() if isinstance(raw_version, str) and grade else None
    version = version if version and len(version) <= 10 else None
    return {
        "nutriscore_grade": grade,
        "nova_group": nova,
        "nutriscore_version": version,
    }


def _suggestion(product: dict, barcode: str | None = None) -> OpenFoodFactsSuggestion:
    raw_brand = product.get("brands")
    if isinstance(raw_brand, str):
        brand = raw_brand.split(",")[0].strip()
    elif isinstance(raw_brand, list):
        brand = next(
            (item.strip() for item in raw_brand if isinstance(item, str) and item.strip()),
            None,
        )
    else:
        brand = None
    return OpenFoodFactsSuggestion(
        code=product.get("code") or barcode,
        product_name=(product.get("product_name") or "").strip() or None,
        brand=brand or None,
        quantity=product.get("quantity") or None,
        ingredients_text=product.get("ingredients_text") or None,
        image_url=product.get("image_front_small_url") or None,
        **_nutrition(product),
    )


def _cached(key: tuple[str, str]):
    item = _cache.get(key)
    if item and item[0] > time.monotonic():
        return True, item[1]
    return False, None


def _remember(key: tuple[str, str], value: object) -> None:
    if len(_cache) >= 512:
        _cache.clear()
    _cache[key] = (time.monotonic() + get_settings().SEARCH_CACHE_TTL_SECONDS, value)


async def get_openfoodfacts_product(barcode: str) -> OpenFoodFactsSuggestion:
    normalized = normalize_barcode(barcode)
    key = ("product", normalized)
    hit, cached = _cached(key)
    if hit:
        if cached is None:
            raise HTTPException(
                status_code=404, detail="Produit inconnu d'Open Food Facts."
            )
        return cached
    try:
        payload = await off_json_get(
            f"{_PRODUCT_URL}/{normalized}.json",
            params={"fields": _OFF_FIELDS},
            max_bytes=2 * 1024 * 1024,
        )
    except OffRateLimited as exc:
        raise HTTPException(
            status_code=429,
            detail="Trop de requêtes vers Open Food Facts.",
            headers=retry_after_headers(exc),
        ) from exc
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("OFF lookup failed: %s", type(exc).__name__)
        raise HTTPException(
            status_code=502, detail="Open Food Facts est indisponible."
        ) from exc
    product = payload.get("product") if payload.get("status") == 1 else None
    result = _suggestion(product, normalized) if isinstance(product, dict) else None
    _remember(key, result)
    if result is None:
        raise HTTPException(
            status_code=404, detail="Produit inconnu d'Open Food Facts."
        )
    return result


async def search_openfoodfacts(q: str, page_size: int) -> OpenFoodFactsSearchResponse:
    key = ("search", f"{q.strip().lower()}:{page_size}")
    hit, cached = _cached(key)
    if hit:
        return OpenFoodFactsSearchResponse(suggestions=cached)
    try:
        payload = await off_json_get(
            OFF_SEARCH_URL,
            params={
                "q": q,
                "page_size": page_size,
                "fields": _OFF_FIELDS,
                "langs": "fr,en",
            },
            max_bytes=2 * 1024 * 1024,
        )
    except OffRateLimited as exc:
        raise HTTPException(
            status_code=429,
            detail="Trop de requêtes vers Open Food Facts.",
            headers=retry_after_headers(exc),
        ) from exc
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("OFF search failed: %s", type(exc).__name__)
        raise HTTPException(
            status_code=502, detail="Open Food Facts est indisponible."
        ) from exc
    products = payload.get("hits", [])
    suggestions = [
        _suggestion(p)
        for p in products
        if isinstance(p, dict)
        and isinstance(p.get("product_name"), str)
        and p["product_name"].strip()
    ]
    _remember(key, suggestions)
    return OpenFoodFactsSearchResponse(suggestions=suggestions)
