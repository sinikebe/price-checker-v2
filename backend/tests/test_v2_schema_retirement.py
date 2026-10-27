"""The private dev schema retires empty obsolete storage without discarding rows."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

import asyncpg
import pytest
from app.db.v2_migrations import connect_v2, migrate_v2

pytestmark = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


@pytest.mark.asyncio
async def test_obsolete_basket_migration_refuses_unexpected_rows():
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_retirement_" + secrets.token_hex(5)
    admin = await connect_v2(base)
    try:
        await admin.execute('CREATE DATABASE "' + database + '"')
    finally:
        await admin.close()
    config = {**base, "database": database}
    try:
        await migrate_v2(config)
        connection = await connect_v2(config)
        try:
            await connection.execute(
                "CREATE TABLE v2_user_baskets (user_id bigint PRIMARY KEY)"
            )
            await connection.execute("INSERT INTO v2_user_baskets VALUES (1)")
            await connection.execute(
                "DELETE FROM v2_schema_migrations "
                "WHERE version='0017_local_basket_only'"
            )
            with pytest.raises(asyncpg.PostgresError, match="Obsolete basket table is not empty"):
                await migrate_v2(config)
            assert await connection.fetchval(
                "SELECT count(*) FROM v2_user_baskets"
            ) == 1
            await connection.execute("DELETE FROM v2_user_baskets")
            assert await migrate_v2(config) == ["0017_local_basket_only"]
            assert await connection.fetchval(
                "SELECT to_regclass('v2_user_baskets')"
            ) is None
        finally:
            await connection.close()
    finally:
        admin = await connect_v2(base)
        try:
            await admin.execute('DROP DATABASE "' + database + '" WITH (FORCE)')
        finally:
            await admin.close()
