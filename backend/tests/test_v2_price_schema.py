"""V2 price-history schema contract on a disposable PostgreSQL database."""

from __future__ import annotations

import json
import os
from pathlib import Path

import asyncpg
import pytest

from app.db.v2_migrations import connect_v2, migrate_v2

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


@pytest.mark.asyncio
async def test_v2_price_provenance_and_constraints():
    config = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    assert "0007_price_history" in await migrate_v2(config)
    connection = await connect_v2(config)
    try:
        async with connection.transaction():
            product_id = await connection.fetchval(
                "INSERT INTO v2_products(data) VALUES('{}'::jsonb) RETURNING id"
            )
            retailer_id = await connection.fetchval(
                "INSERT INTO v2_retailers(code,name,import_key) "
                "VALUES('shop-a','Shop A','sample:retailer:1') RETURNING id"
            )
            other_retailer_id = await connection.fetchval(
                "INSERT INTO v2_retailers(code,name) "
                "VALUES('shop-b','Shop B') RETURNING id"
            )
            store_id = await connection.fetchval(
                "INSERT INTO v2_stores(retailer_id,name,import_key) "
                "VALUES($1,'Shop A Centre','sample:store:1') RETURNING id",
                retailer_id,
            )
            author_id = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES('Alice','alice','test','confirmed') RETURNING id"
            )
            reviewer_id = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES('Admin','admin','test','admin') RETURNING id"
            )
            draft_id = await connection.fetchval(
                "INSERT INTO v2_price_drafts(author_id,product_id,retailer_id,"
                "store_id,entry_kind,price,observed_at) "
                "VALUES($1,$2,$3,$4,'manual',2.20,now()) RETURNING id",
                author_id, product_id, retailer_id, store_id,
            )
            assert await connection.fetchval(
                "SELECT status FROM v2_price_drafts WHERE id=$1", draft_id
            ) == 'draft'
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_price_observations WHERE price_draft_id=$1",
                draft_id,
            ) == 0
            with pytest.raises(asyncpg.CheckViolationError):
                async with connection.transaction():
                    await connection.execute(
                        "UPDATE v2_price_drafts SET status='approved' WHERE id=$1",
                        draft_id,
                    )
            with pytest.raises(asyncpg.ForeignKeyViolationError):
                async with connection.transaction():
                    await connection.execute(
                        "INSERT INTO v2_offers(retailer_id,store_id,source_kind,"
                        "captured_via,channel,title,price_amount,collected_at) "
                        "VALUES($1,$2,'capture','paste','web','Wrong shop',2,now())",
                        other_retailer_id,
                        store_id,
                    )
            offers = []
            for key in ('sample:offer:1', 'sample:offer:2'):
                offers.append(
                    await connection.fetchval(
                        "INSERT INTO v2_offers(retailer_id,store_id,source_kind,"
                        "captured_via,channel,title,price_amount,product_url,"
                        "collected_at,import_key) "
                        "VALUES($1,$2,'capture','bookmarklet','web','Tea',2.50,"
                        "'https://example.org/tea',now(),$3) RETURNING id",
                        retailer_id,
                        store_id,
                        key,
                    )
                )
            await connection.execute(
                "INSERT INTO v2_offer_product_links(offer_id,product_id,link_type,"
                "verified) VALUES($1,$2,'capture',true)",
                offers[0],
                product_id,
            )
            observation_id = await connection.fetchval(
                "INSERT INTO v2_price_observations(product_id,retailer_id,"
                "store_id,offer_id,source,price,observed_at,import_key) "
                "VALUES($1,$2,$3,$4,'connector',2.50,now(),'sample:observation:1') "
                "RETURNING id",
                product_id,
                retailer_id,
                store_id,
                offers[0],
            )
            await connection.execute(
                "UPDATE v2_price_drafts SET status='approved',reviewed_by=$1,"
                "reviewed_at=now() WHERE id=$2", reviewer_id, draft_id
            )
            correction_id = await connection.fetchval(
                "INSERT INTO v2_price_observations(product_id,retailer_id,"
                "store_id,source,contributor_id,price_draft_id,approved_by,"
                "approved_at,price,observed_at,corrected_price,"
                "correction_status) VALUES($1,$2,$3,'manual',$4,$5,$6,now(),2.20,"
                "now()+interval '1 second',2.50,'active') RETURNING id",
                product_id, retailer_id, store_id, author_id, draft_id, reviewer_id,
            )
            await connection.execute(
                "INSERT INTO v2_price_observations(product_id,retailer_id,"
                "store_id,offer_id,source,price,observed_at,superseded,"
                "superseded_by_correction_id) VALUES($1,$2,$3,$4,'connector',"
                "2.50,now()+interval '2 seconds',true,$5)",
                product_id,
                retailer_id,
                store_id,
                offers[1],
                correction_id,
            )
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_offers WHERE store_id=$1", store_id
            ) == 2
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_price_observations "
                "WHERE product_id=$1 AND NOT superseded",
                product_id,
            ) == 2
            assert await connection.fetchval(
                "SELECT corrected_price FROM v2_price_observations WHERE id=$1",
                correction_id,
            ) == 2.50
            assert observation_id != correction_id
            assert await connection.fetchval(
                "SELECT contributor_id FROM v2_price_observations WHERE id=$1",
                correction_id,
            ) == author_id
            external_id = await connection.fetchval(
                "INSERT INTO v2_price_observations(product_id,retailer_id,store_id,"
                "source,source_provider,source_record_id,price,observed_at) "
                "VALUES($1,$2,$3,'third_party','open_prices','record-42',2.45,"
                "now()+interval '3 seconds') RETURNING id",
                product_id, retailer_id, store_id,
            )
            assert await connection.fetchval(
                "SELECT source_provider FROM v2_price_observations WHERE id=$1",
                external_id,
            ) == 'open_prices'
            with pytest.raises(asyncpg.CheckViolationError):
                async with connection.transaction():
                    await connection.execute(
                        "INSERT INTO v2_price_observations(product_id,retailer_id,"
                        "store_id,source,price,observed_at) "
                        "VALUES($1,$2,$3,'third_party',2.45,now())",
                        product_id, retailer_id, store_id,
                    )
            with pytest.raises(asyncpg.UniqueViolationError):
                async with connection.transaction():
                    await connection.execute(
                        "INSERT INTO v2_price_observations(product_id,retailer_id,"
                        "store_id,offer_id,source,price,observed_at) "
                        "VALUES($1,$2,$3,$4,'connector',2.50,now())",
                        product_id,
                        retailer_id,
                        store_id,
                        offers[0],
                    )
            with pytest.raises(asyncpg.CheckViolationError):
                async with connection.transaction():
                    await connection.execute(
                        "INSERT INTO v2_price_observations(product_id,retailer_id,"
                        "store_id,source,price,observed_at,corrected_price,"
                        "correction_status) VALUES($1,$2,$3,'connector',2.20,"
                        "now(),2.50,'active')",
                        product_id,
                        retailer_id,
                        store_id,
                    )
    finally:
        await connection.close()
