"""The private dev schema retires empty obsolete storage without discarding rows."""

from __future__ import annotations

import asyncpg
import pytest

from app.db.v2_migrations import connect_v2, migrate_v2
from conftest import disposable_database, requires_v2_db

pytestmark = requires_v2_db


@pytest.mark.asyncio
async def test_obsolete_basket_migration_refuses_unexpected_rows():
    async with disposable_database("v2_retirement_") as config:
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
