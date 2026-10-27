"""Six-month private-record expiry must not remove published contributions."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

import pytest
from app.db.v2_migrations import connect_v2, migrate_v2
from app.services.v2_private_retention import purge_private_data

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


@pytest.mark.asyncio
async def test_closed_private_records_expire_without_losing_publication():
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_retention_" + secrets.token_hex(5)
    root = await connect_v2(base)
    try:
        await root.execute('CREATE DATABASE "' + database + '"')
    finally:
        await root.close()
    config = {**base, "database": database}
    try:
        await migrate_v2(config)
        connection = await connect_v2(config)
        try:
            author = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES('author','author','hash','confirmed') RETURNING id"
            )
            reviewer = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES('reviewer','reviewer','hash','admin') RETURNING id"
            )
            product = await connection.fetchval(
                "INSERT INTO v2_products(data) VALUES('{\"name\":\"Public\"}'::jsonb) RETURNING id"
            )
            recipe = await connection.fetchval(
                "INSERT INTO v2_recipes(author_id,title,base_servings,steps) "
                "VALUES($1,'Public recipe',2,'[\"Mix\"]'::jsonb) RETURNING id", author,
            )
            old_product = await connection.fetchval(
                "INSERT INTO v2_product_drafts(author_id,data,status,approved_by,approved_at) "
                "VALUES($1,'{}'::jsonb,'approved',$2,now()-interval '7 months') RETURNING id",
                author, reviewer,
            )
            await connection.execute(
                "INSERT INTO v2_product_events(product_id,draft_id,actor_id,event_type,after_data) "
                "VALUES($1,$2,$3,'created','{}'::jsonb)", product, old_product, author,
            )
            pending_product = await connection.fetchval(
                "INSERT INTO v2_product_drafts(author_id,data,updated_at) "
                "VALUES($1,'{}'::jsonb,now()-interval '7 months') RETURNING id", author,
            )
            fresh_product = await connection.fetchval(
                "INSERT INTO v2_product_drafts(author_id,data,status,approved_by,approved_at) "
                "VALUES($1,'{}'::jsonb,'approved',$2,now()) RETURNING id", author, reviewer,
            )
            retailer = await connection.fetchval(
                "INSERT INTO v2_retailers(code,name) VALUES('ci','CI') RETURNING id"
            )
            store = await connection.fetchval(
                "INSERT INTO v2_stores(retailer_id,name) VALUES($1,'Store') RETURNING id",
                retailer,
            )
            old_price = await connection.fetchval(
                "INSERT INTO v2_price_drafts"
                "(author_id,product_id,retailer_id,store_id,entry_kind,price,observed_at,"
                "status,reviewed_by,reviewed_at) "
                "VALUES($1,$2,$3,$4,'manual',3,now(),'approved',$5,"
                "now()-interval '7 months') RETURNING id",
                author, product, retailer, store, reviewer,
            )
            observation = await connection.fetchval(
                "INSERT INTO v2_price_observations"
                "(product_id,retailer_id,store_id,source,contributor_id,price_draft_id,"
                "approved_by,approved_at,price,observed_at) "
                "VALUES($1,$2,$3,'manual',$4,$5,$6,now(),3,now()) RETURNING id",
                product, retailer, store, author, old_price, reviewer,
            )
            pending_price = await connection.fetchval(
                "INSERT INTO v2_price_drafts"
                "(author_id,product_id,retailer_id,store_id,entry_kind,price,observed_at,updated_at) "
                "VALUES($1,$2,$3,$4,'manual',4,now(),now()-interval '7 months') RETURNING id",
                author, product, retailer, store,
            )
            old_submission = await connection.fetchval(
                "INSERT INTO v2_recipe_submissions"
                "(author_id,recipe_id,base_revision,payload,status,reviewed_at,reviewer_id) "
                "VALUES($1,$2,1,'{}'::jsonb,'approved',now()-interval '7 months',$3) "
                "RETURNING id", author, recipe, reviewer,
            )
            pending_submission = await connection.fetchval(
                "INSERT INTO v2_recipe_submissions"
                "(author_id,payload,created_at) "
                "VALUES($1,'{}'::jsonb,now()-interval '7 months') RETURNING id", author,
            )
            old_report = await connection.fetchval(
                "INSERT INTO v2_content_reports"
                "(kind,content_id,reporter_id,reason,status,reviewed_at,reviewed_by) "
                "VALUES('product',$1,$2,'Old report reason','dismissed',"
                "now()-interval '7 months',$3) RETURNING id", product, author, reviewer,
            )
            open_report = await connection.fetchval(
                "INSERT INTO v2_content_reports(kind,content_id,reporter_id,reason,created_at) "
                "VALUES('recipe',$1,$2,'Open report reason',now()-interval '7 months') "
                "RETURNING id", recipe, author,
            )
            await connection.execute(
                "INSERT INTO v2_content_withdrawals(kind,content_id,reason,withdrawn_by) "
                "VALUES('product',$1,'Personal information in report',$2)",
                product, reviewer,
            )

            result = await purge_private_data(connection)
            assert result == {
                "product_drafts": 1, "price_drafts": 1,
                "recipe_submissions": 1, "reports": 1,
            }
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_products WHERE id=$1", product,
            ) == 1
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_recipes WHERE id=$1", recipe,
            ) == 1
            assert await connection.fetchval(
                "SELECT price_draft_id FROM v2_price_observations WHERE id=$1", observation,
            ) is None
            assert await connection.fetchval(
                "SELECT draft_id FROM v2_product_events WHERE product_id=$1", product,
            ) is None
            for table, row_id in (
                ("v2_product_drafts", pending_product),
                ("v2_product_drafts", fresh_product),
                ("v2_price_drafts", pending_price),
                ("v2_recipe_submissions", pending_submission),
                ("v2_content_reports", open_report),
            ):
                assert await connection.fetchval(
                    f"SELECT count(*) FROM {table} WHERE id=$1", row_id,
                ) == 1
            assert await connection.fetchval(
                "SELECT reason FROM v2_content_withdrawals "
                "WHERE kind='product' AND content_id=$1", product,
            ) == "Signalement traité"
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_content_reports WHERE id=$1", old_report,
            ) == 0
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_recipe_submissions WHERE id=$1", old_submission,
            ) == 0
            assert await purge_private_data(connection) == {
                "product_drafts": 0, "price_drafts": 0,
                "recipe_submissions": 0, "reports": 0,
            }
        finally:
            await connection.close()
    finally:
        root = await connect_v2(base)
        try:
            await root.execute('DROP DATABASE "' + database + '" WITH (FORCE)')
        finally:
            await root.close()
