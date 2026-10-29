"""Low-volume Open Prices sync for current French/EUR barcode products.

The persisted global slot admits at most one four-product cycle per hour across
workers and restarts. Each barcode is checked at most once every 24 hours.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import date, datetime, time
from decimal import Decimal, InvalidOperation
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo

import httpx

from app.api.v2.auth import _connect
from app.api.v2.setup import _read_config
from app.api.v2.stores import name_key
from app.core.config import get_settings

logger = logging.getLogger(__name__)
PARIS = ZoneInfo("Europe/Paris")
MAX_PRODUCTS_PER_CYCLE = 4
PRICE_PAGE_SIZE = 100
MIN_INTERVAL_SECONDS = 15
ORIGINS = {
    "dev": "https://prices.openfoodfacts.net",
    "prod": "https://prices.openfoodfacts.org",
}


def _valid_price(item: dict, barcode: str) -> tuple[dict, Decimal, datetime] | None:
    """Reject duplicates, promotions, foreign currencies and unlocated prices."""
    location = item.get("location")
    if not isinstance(location, dict):
        return None
    if (item.get("type") != "PRODUCT" or item.get("product_code") != barcode
            or item.get("currency") != "EUR"
            or item.get("price_is_discounted") is True
            or item.get("duplicate_of") is not None
            or location.get("type") != "OSM"
            or location.get("osm_address_country_code") != "FR"
            or location.get("osm_type") not in {"NODE", "WAY", "RELATION"}
            or not isinstance(location.get("osm_id"), int)
            or not isinstance(location.get("id"), int)
            or not isinstance(item.get("id"), int)):
        return None
    name = location.get("osm_name") or location.get("osm_brand") or ""
    city = location.get("osm_address_city")
    postcode = location.get("osm_address_postcode")
    if (not isinstance(name, str) or not name.strip()
            or not isinstance(city, str) or not city.strip()
            or not isinstance(postcode, str) or not postcode.strip()):
        return None
    try:
        value = Decimal(str(item["price"]))
        observed = date.fromisoformat(item["date"])
        if (not value.is_finite() or value < 0 or value > 99999999.99
                or observed > datetime.now(PARIS).date()):
            return None
        amount = value.quantize(Decimal("0.01"))
    except (ValueError, TypeError, InvalidOperation, KeyError):
        return None
    return location, amount, datetime.combine(observed, time(12), tzinfo=PARIS)


def _retry_seconds(header: str | None) -> int:
    """Respect Retry-After, with a conservative 6-hour floor and 24-hour cap."""
    seconds = 0
    if header:
        try:
            seconds = int(header)
        except ValueError:
            try:
                seconds = int((parsedate_to_datetime(header) - datetime.now().astimezone()).total_seconds())
            except (ValueError, TypeError, OverflowError):
                pass
    return max(6 * 3600, min(seconds, 24 * 3600))


async def _source_retailer(connection, brand: str) -> int:
    existing = await connection.fetchval(
        "SELECT id FROM v2_retailers WHERE lower(name)=lower($1) ORDER BY id LIMIT 1",
        brand,
    )
    if existing is not None:
        return existing
    digest = hashlib.sha256(brand.casefold().encode()).hexdigest()[:24]
    return await connection.fetchval(
        "INSERT INTO v2_retailers(code,name) VALUES($1,$2) "
        "ON CONFLICT(code) DO UPDATE SET code=EXCLUDED.code RETURNING id",
        "open-prices-" + digest, brand,
    )


async def _store(connection, location: dict) -> tuple[int, int, int | None] | None:
    """Return canonical retailer/store and the external source retailer, if distinct."""
    osm_type = location["osm_type"].lower()
    osm_id = location["osm_id"]
    import_key = "open_prices:location:" + str(location["id"])
    if await connection.fetchval(
        "SELECT EXISTS(SELECT 1 FROM v2_deleted_store_sources WHERE source_key=ANY($1::text[]))",
        ["import:" + import_key, "osm:" + osm_type + ":" + str(osm_id)],
    ):
        return None
    source_brand = location.get("osm_brand")
    source_brand = source_brand.strip()[:200] if isinstance(source_brand, str) else ""
    # The source's stable location ID also survives a merge. OSM IDs may be
    # changed upstream, so checking only OSM identity can recreate a donor.
    existing = await connection.fetchrow(
        "SELECT c.id,c.retailer_id,c.active FROM v2_stores old "
        "LEFT JOIN v2_content_merges m ON m.kind='store' AND m.from_id=old.id "
        "JOIN v2_stores c ON c.id=COALESCE(m.to_id,old.id) "
        "WHERE old.import_key=$3 "
        "UNION ALL SELECT s.id,s.retailer_id,s.active FROM v2_stores s "
        "WHERE s.osm_type=$1 AND s.osm_id=$2 "
        "UNION ALL SELECT s.id,s.retailer_id,s.active FROM v2_store_osm_aliases a "
        "JOIN v2_stores s ON s.id=a.store_id WHERE a.osm_type=$1 AND a.osm_id=$2 "
        "LIMIT 1",
        osm_type, osm_id, import_key,
    )
    if existing:
        if not existing["active"]:
            return None
        source_id = await _source_retailer(connection, source_brand) if source_brand else None
        await connection.execute(
            "UPDATE v2_stores SET city=COALESCE(NULLIF(btrim(city),''),$1),"
            "postal_code=COALESCE(NULLIF(btrim(postal_code),''),$2) WHERE id=$3",
            location["osm_address_city"].strip(), location["osm_address_postcode"].strip(), existing["id"],
        )
        await connection.execute(
            "INSERT INTO v2_store_osm_aliases(osm_type,osm_id,store_id) "
            "VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            osm_type, osm_id, existing["id"],
        )
        return (existing["retailer_id"], existing["id"],
                source_id if source_id != existing["retailer_id"] else None)
    brand = (source_brand or location["osm_name"]).strip()[:200]
    name = (location.get("osm_name") or brand).strip()[:300]
    if not brand or not name:
        return None
    retailer = await _source_retailer(connection, brand)
    # Approved external aliases may map across explicitly grouped retailer
    # labels. An OSM identity still takes precedence over a name match.
    postcode = (location.get("osm_address_postcode") or "").strip()
    if postcode:
        candidates = await connection.fetch(
            "SELECT s.id,s.city,s.retailer_id FROM v2_store_aliases a "
            "JOIN v2_stores s ON s.id=a.store_id "
            "JOIN v2_retailers r ON r.id=s.retailer_id "
            "WHERE a.source='open_prices' AND a.name_key=$1 "
            "AND s.active "
            "AND r.group_id=(SELECT group_id FROM v2_retailers WHERE id=$2) "
            "AND s.postal_code=$3 AND s.osm_id IS NULL "
            "AND NOT EXISTS (SELECT 1 FROM v2_content_merges m "
            "WHERE m.kind='store' AND m.from_id=s.id) "
            "AND NULLIF(btrim(s.city),'') IS NOT NULL",
            name_key(name), retailer, postcode,
        )
        location_city = name_key(location.get("osm_address_city") or "")
        candidates = [row for row in candidates if not location_city or not row["city"]
                      or name_key(row["city"]) == location_city]
        if len(candidates) == 1:
            await connection.execute(
                "INSERT INTO v2_store_osm_aliases(osm_type,osm_id,store_id) "
                "VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
                osm_type, osm_id, candidates[0]["id"],
            )
            return (candidates[0]["retailer_id"], candidates[0]["id"],
                    retailer if retailer != candidates[0]["retailer_id"] else None)
    inserted = await connection.fetchrow(
        """INSERT INTO v2_stores(
            retailer_id,name,city,postal_code,osm_type,osm_id,import_key
        ) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT DO NOTHING RETURNING id,retailer_id""",
        retailer, name, (location.get("osm_address_city") or None),
        (location.get("osm_address_postcode") or None),
        osm_type, osm_id, import_key,
    )
    if inserted:
        return inserted["retailer_id"], inserted["id"], None
    # A concurrent insert or donor import_key: resolve once, never recurse.
    existing = await connection.fetchrow(
        "SELECT c.id,c.retailer_id,c.active FROM v2_stores old "
        "LEFT JOIN v2_content_merges m ON m.kind='store' AND m.from_id=old.id "
        "JOIN v2_stores c ON c.id=COALESCE(m.to_id,old.id) "
        "WHERE old.import_key=$1 OR (old.osm_type=$2 AND old.osm_id=$3) "
        "ORDER BY (old.import_key=$1) DESC LIMIT 1",
        import_key, osm_type, osm_id,
    )
    return (existing["retailer_id"], existing["id"],
            retailer if retailer != existing["retailer_id"] else None) if existing and existing["active"] else None


async def _save_items(connection, product_id: int, barcode: str, items: list) -> int:
    imported = 0
    async with connection.transaction():
        for item in items:
            if not isinstance(item, dict):
                continue
            parsed = _valid_price(item, barcode)
            if parsed is None:
                continue
            location, amount, observed_at = parsed
            # A price imported before a product merge keeps its old import_key,
            # but its product_id is moved. Do not create a store while
            # processing an already-known source record.
            previous = await connection.fetchval(
                "SELECT id FROM v2_price_observations WHERE product_id=$1 "
                "AND source_provider='open_prices' AND source_record_id=$2 LIMIT 1",
                product_id, str(item["id"]),
            )
            if previous:
                continue
            identity = await _store(connection, location)
            if identity is None:
                continue
            retailer_id, store_id, source_retailer_id = identity
            result = await connection.execute(
                """INSERT INTO v2_price_observations(
                    product_id,retailer_id,store_id,source,source_provider,
                    source_record_id,price,observed_at,sales_channel,note,import_key,
                    source_retailer_id
                ) VALUES($1,$2,$3,'third_party','open_prices',$4,$5,$6,
                         'in_store',$7,$8,$9)
                ON CONFLICT(import_key) DO NOTHING""",
                product_id, retailer_id, store_id, str(item["id"]), amount,
                observed_at,
                "Open Prices / Open Food Facts (ODbL) · relevé tiers non vérifié.",
                "open_prices:price:" + str(item["id"]) + ":product:" + str(product_id),
                source_retailer_id,
            )
            imported += result == "INSERT 0 1"
    return imported


async def _postpone(connection, seconds: int) -> None:
    await connection.execute(
        "UPDATE v2_open_prices_sync_control "
        "SET next_run_at=greatest(next_run_at,now()+($1 * interval '1 second')) "
        "WHERE singleton=true", seconds,
    )


async def run_sync_cycle(client: httpx.AsyncClient | None = None) -> dict:
    """Fetch one bounded cycle; reusable with an injected test HTTP client."""
    if _read_config() is None:
        return {"status": "unconfigured", "requested": 0, "imported": 0}
    connection = await _connect()
    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(
            timeout=10, follow_redirects=False,
            headers={"User-Agent": "PriceCheckerV2/0.1 (+https://github.com/sinikebe/price-checker-v2)"},
        )
    try:
        # Atomic global claim: no other worker, including on another host, can
        # start a cycle until the next slot. Never hold a transaction over HTTP.
        claimed = await connection.fetchval(
            "UPDATE v2_open_prices_sync_control "
            "SET next_run_at=now()+interval '1 hour' "
            "WHERE singleton=true AND next_run_at<=now() "
            "RETURNING singleton"
        )
        if not claimed:
            return {"status": "not_due", "requested": 0, "imported": 0}
        rows = await connection.fetch(
            """WITH aliases AS (
                SELECT DISTINCT ON (COALESCE(m.to_id,p.id),
                                    lpad(p.data->>'ean',14,'0'))
                       COALESCE(m.to_id,p.id) AS id,p.data->>'ean' AS barcode
                FROM v2_products p
                LEFT JOIN v2_content_merges m
                  ON m.kind='product' AND m.from_id=p.id
                JOIN v2_products canonical ON canonical.id=COALESCE(m.to_id,p.id)
                WHERE p.data->>'ean' ~ '^([0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$'
                  AND NOT EXISTS (SELECT 1 FROM v2_products next
                                  WHERE next.predecessor_id=p.id)
                  AND NOT EXISTS (SELECT 1 FROM v2_products next
                                  WHERE next.predecessor_id=canonical.id)
                  AND NOT EXISTS (SELECT 1 FROM v2_content_withdrawals w
                                  WHERE w.kind='product' AND w.content_id=canonical.id)
                ORDER BY COALESCE(m.to_id,p.id),lpad(p.data->>'ean',14,'0'),
                         (p.id=COALESCE(m.to_id,p.id)) DESC,p.id
            )
            SELECT a.id,a.barcode FROM aliases a
            LEFT JOIN v2_open_prices_sync_state s
              ON s.product_id=a.id AND s.barcode=a.barcode
            WHERE s.checked_at IS NULL OR s.checked_at<=now()-interval '24 hours'
            ORDER BY s.checked_at NULLS FIRST,a.id,a.barcode LIMIT $1""",
            MAX_PRODUCTS_PER_CYCLE,
        )
        origin = ORIGINS["dev" if get_settings().APP_ENV == "dev" else "prod"]
        requested = imported = 0
        status = "ok"
        for index, row in enumerate(rows):
            if index:
                await asyncio.sleep(MIN_INTERVAL_SECONDS)
            try:
                response = await client.get(
                    origin + "/api/v1/prices",
                    params={"product_code": row["barcode"], "size": PRICE_PAGE_SIZE,
                            "order_by": "-date", "duplicate_of__isnull": "true"},
                )
                requested += 1
                if response.status_code in {429, 503}:
                    await _postpone(connection, _retry_seconds(response.headers.get("Retry-After")))
                    status = "rate_limited" if response.status_code == 429 else "unavailable"
                    break
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
                    raise TypeError("Malformed Open Prices response")
                count = await _save_items(connection, row["id"], row["barcode"], payload["items"])
                imported += count
                await connection.execute(
                    """INSERT INTO v2_open_prices_sync_state(product_id,barcode,checked_at,imported_count)
                       VALUES($1,$2,now(),$3) ON CONFLICT(product_id,barcode) DO UPDATE SET
                       checked_at=excluded.checked_at,
                       imported_count=v2_open_prices_sync_state.imported_count+$3""",
                    row["id"], row["barcode"], count,
                )
            except (httpx.HTTPError, ValueError, TypeError) as exc:
                logger.warning("Open Prices sync paused after %s", type(exc).__name__)
                await _postpone(connection, 6 * 3600)
                status = "error"
                break
        return {"status": status, "requested": requested, "imported": imported}
    finally:
        if owns_client:
            await client.aclose()
        await connection.close()


async def open_prices_worker() -> None:
    await asyncio.sleep(60)
    while True:
        try:
            await run_sync_cycle()
        except Exception:
            logger.exception("Open Prices synchronization unavailable")
        await asyncio.sleep(300)
