"""Store imports cannot cross a concurrent permanent deletion."""

from __future__ import annotations

import asyncio
import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest

from app.api.v2 import prices
from app.db.v2_migrations import connect_v2, migrate_v2
from app.services import v2_open_prices_sync as sync

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


class PauseAfterTombstoneRead:
    def __init__(self, connection, seen: asyncio.Event, resume: asyncio.Event):
        self.connection = connection
        self.seen = seen
        self.resume = resume

    def __getattr__(self, name):
        return getattr(self.connection, name)

    async def fetchval(self, query, *args):
        value = await self.connection.fetchval(query, *args)
        if "v2_deleted_store_sources" in query:
            self.seen.set()
            await self.resume.wait()
        return value


@pytest.mark.asyncio
async def test_manual_and_open_prices_imports_do_not_revive_deleted_store():
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    name = "store_delete_race_" + uuid4().hex[:10]
    admin = await connect_v2(base)
    await admin.execute('CREATE DATABASE "' + name + '"')
    config = {**base, "database": name}
    try:
        await migrate_v2(config)
        setup = await connect_v2(config)
        try:
            retailer = await setup.fetchval(
                "INSERT INTO v2_retailers(code,name) VALUES('race','Race Market') RETURNING id"
            )
            manual_key = "manual:store:" + prices._hash(
                "|".join((str(retailer), "Centre", "Paris", "75001"))
            )
            manual_store = await setup.fetchval(
                "INSERT INTO v2_stores(retailer_id,name,city,postal_code,import_key) "
                "VALUES($1,'Centre','Paris','75001',$2) RETURNING id",
                retailer, manual_key,
            )
            product = await setup.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
                json.dumps({"name": "Produit test", "ean": "3017620422003"}),
            )
            osm_key = "open_prices:location:44001"
            osm_store = await setup.fetchval(
                "INSERT INTO v2_stores(retailer_id,name,city,postal_code,"
                "osm_type,osm_id,import_key) "
                "VALUES($1,'Test Épicerie','Paris','75001','node',990001,$2) RETURNING id",
                retailer, osm_key,
            )
        finally:
            await setup.close()

        async def exercise(store_id, keys, create):
            writer = await connect_v2(config)
            deleter = await connect_v2(config)
            seen, resume = asyncio.Event(), asyncio.Event()
            wrapped = PauseAfterTombstoneRead(writer, seen, resume)

            async def write():
                async with writer.transaction():
                    return await create(wrapped)

            async def delete():
                async with deleter.transaction():
                    await deleter.execute("SELECT pg_advisory_xact_lock(795244, 1)")
                    await deleter.executemany(
                        "INSERT INTO v2_deleted_store_sources(source_key) VALUES($1)",
                        [("import:" + key,) for key in keys],
                    )
                    await deleter.execute(
                        "DELETE FROM v2_price_observations WHERE store_id=$1", store_id
                    )
                    await deleter.execute(
                        "DELETE FROM v2_store_osm_aliases WHERE store_id=$1", store_id
                    )
                    await deleter.execute("DELETE FROM v2_stores WHERE id=$1", store_id)

            try:
                writing = asyncio.create_task(write())
                await asyncio.wait_for(seen.wait(), timeout=5)
                deleting = asyncio.create_task(delete())
                try:
                    # Without the shared lock, deletion commits while the
                    # creator is paused and its next INSERT revives the store.
                    await asyncio.wait_for(asyncio.shield(deleting), timeout=0.2)
                except TimeoutError:
                    pass
                resume.set()
                await asyncio.wait_for(writing, timeout=5)
                await asyncio.wait_for(deleting, timeout=5)
                assert await writer.fetchval(
                    "SELECT count(*) FROM v2_stores WHERE id=$1 OR import_key=$2",
                    store_id, keys[0],
                ) == 0
                assert await writer.fetchval(
                    "SELECT count(*) FROM v2_deleted_store_sources "
                    "WHERE source_key=$1", "import:" + keys[0],
                ) == 1
            finally:
                resume.set()
                await writer.close()
                await deleter.close()

        payload = prices.PriceDraftCreate(
            retailer="Race Market", store_name="Centre", city="Paris",
            postal_code="75001", price="2.50", observed_at=datetime.now(UTC),
        )
        await exercise(
            manual_store, [manual_key],
            lambda connection: prices._retailer_store(connection, payload, {}),
        )
        item = {
            "id": 41001, "type": "PRODUCT", "product_code": "3017620422003",
            "price": 2.49, "currency": "EUR", "price_is_discounted": False,
            "date": (datetime.now(sync.PARIS).date() - timedelta(days=1)).isoformat(),
            "duplicate_of": None,
            "location": {
                "id": 44001, "type": "OSM", "osm_type": "NODE", "osm_id": 990001,
                "osm_name": "Test Épicerie", "osm_brand": "Race Market",
                "osm_address_city": "Paris", "osm_address_postcode": "75001",
                "osm_address_country_code": "FR",
            },
        }
        await exercise(
            osm_store, [osm_key],
            lambda connection: sync._save_items(
                connection, product, "3017620422003", [item]
            ),
        )
    finally:
        await admin.execute('DROP DATABASE "' + name + '" WITH (FORCE)')
        await admin.close()
