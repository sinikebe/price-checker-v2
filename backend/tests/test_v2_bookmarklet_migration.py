"""Existing approved captures retain provenance when the source is migrated."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

import pytest
from app.db.v2_migrations import MIGRATIONS, connect_v2, migrate_v2

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


@pytest.mark.asyncio
async def test_approved_capture_source_is_backfilled():
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_capture_upgrade_" + secrets.token_hex(5)
    admin = await connect_v2(base)
    try:
        await admin.execute('CREATE DATABASE "' + database + '"')
    finally:
        await admin.close()
    config = {**base, "database": database}
    try:
        connection = await connect_v2(config)
        try:
            await connection.execute(
                "CREATE TABLE v2_schema_migrations (version text PRIMARY KEY,"
                "applied_at timestamptz NOT NULL DEFAULT now())"
            )
            for version, ddl in MIGRATIONS.items():
                if version == "0021_bookmarklet_price_source":
                    break
                await connection.execute(ddl)
                await connection.execute(
                    "INSERT INTO v2_schema_migrations(version) VALUES($1)", version,
                )
            user_id = await connection.fetchval(
                "INSERT INTO v2_users(username,username_key,password_hash,role) "
                "VALUES('upgrader','upgrader','test','admin') RETURNING id"
            )
            product_id = await connection.fetchval(
                "INSERT INTO v2_products(data) VALUES($1::jsonb) RETURNING id",
                json.dumps({"name": "Migration test", "brand": "Test",
                            "package": "sachet", "quantity": "250 g",
                            "ean": "3073781178042"}),
            )
            retailer_id = await connection.fetchval(
                "INSERT INTO v2_retailers(code,name) "
                "VALUES('migration-test','Migration Test') RETURNING id"
            )
            store_id = await connection.fetchval(
                "INSERT INTO v2_stores(retailer_id,name,city,postal_code) "
                "VALUES($1,'Centre','Paris','75001') RETURNING id", retailer_id,
            )
            draft_id = await connection.fetchval(
                "INSERT INTO v2_price_drafts("
                "author_id,product_id,retailer_id,store_id,entry_kind,captured_via,"
                "source_url,capture_ean,price,observed_at,status,reviewed_by,reviewed_at) "
                "VALUES($1,$2,$3,$4,'capture','bookmarklet',$5,$6,2.50,now(),"
                "'approved',$1,now()) RETURNING id",
                user_id, product_id, retailer_id, store_id,
                "https://example.org/migration", "3073781178042",
            )
            observation_id = await connection.fetchval(
                "INSERT INTO v2_price_observations("
                "product_id,retailer_id,store_id,source,price_draft_id,"
                "contributor_id,approved_by,approved_at,price,observed_at,"
                "corrected_price,correction_status) "
                "VALUES($1,$2,$3,'manual',$4,$5,$5,now(),2.50,now(),"
                "2.30,'active') RETURNING id",
                product_id, retailer_id, store_id, draft_id, user_id,
            )
        finally:
            await connection.close()
        assert await migrate_v2(config) == ["0021_bookmarklet_price_source", "0022_duplicate_merges", "0023_merge_manual_observations"]
        connection = await connect_v2(config)
        try:
            row = await connection.fetchrow(
                "SELECT source,source_url,capture_ean,corrected_price,"
                "correction_status FROM v2_price_observations WHERE id=$1",
                observation_id,
            )
            assert row["source"] == "bookmarklet"
            assert row["source_url"] == "https://example.org/migration"
            assert row["capture_ean"] == "3073781178042"
            assert str(row["corrected_price"]) == "2.30"
            assert row["correction_status"] == "active"
        finally:
            await connection.close()
    finally:
        admin = await connect_v2(base)
        try:
            await admin.execute('DROP DATABASE "' + database + '" WITH (FORCE)')
        finally:
            await admin.close()
