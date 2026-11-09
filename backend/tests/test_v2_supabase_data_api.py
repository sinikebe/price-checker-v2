"""On Supabase, the application's tables are closed to the public Data API; elsewhere nothing changes."""

from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path

from app.db.v2_migrations import connect_v2, migrate_v2
from conftest import disposable_database, requires_v2_db

pytestmark = requires_v2_db

STILL_OPEN = """
    SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND starts_with(c.relname, 'v2_') AND c.relkind = 'r'
      AND (NOT c.relrowsecurity OR has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
           OR has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE'))
"""


@contextlib.asynccontextmanager
async def supabase_roles():
    """The roles a Supabase project has; those created here are dropped afterwards."""
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    admin = await connect_v2(base)
    created = []
    try:
        for role in ("anon", "authenticated"):
            if await admin.fetchval("SELECT to_regrole($1) IS NULL", role):
                await admin.execute(f"CREATE ROLE {role} NOLOGIN")
                created.append(role)
        yield
    finally:
        for role in created:
            await admin.execute(f"DROP ROLE {role}")
        await admin.close()


async def test_a_new_supabase_database_is_closed_to_the_data_api():
    async with supabase_roles(), disposable_database("v2_data_api_") as config:
        connection = await connect_v2(config)
        try:
            assert await connection.fetchval(STILL_OPEN) == 0
            assert await connection.fetchval("SELECT relrowsecurity FROM pg_class WHERE oid = 'v2_schema_migrations'::regclass")
            assert not await connection.fetchval("SELECT has_sequence_privilege('anon', 'v2_users_id_seq', 'USAGE')")
        finally:
            await connection.close()


async def test_an_existing_database_and_a_later_table_are_closed_at_the_next_run():
    async with supabase_roles(), disposable_database("v2_data_api_") as config:
        connection = await connect_v2(config)
        try:
            # As Supabase leaves a table the application created before this protection existed.
            await connection.execute("ALTER TABLE v2_users DISABLE ROW LEVEL SECURITY")
            await connection.execute("GRANT ALL ON v2_users TO PUBLIC, anon, authenticated")
            await connection.execute("CREATE TABLE v2_added_later (id integer)")
            await connection.execute("GRANT ALL ON v2_added_later TO anon")
            assert await connection.fetchval(STILL_OPEN) == 2

            assert await migrate_v2(config) == [], "no migration is applied again"
            assert await connection.fetchval(STILL_OPEN) == 0
            assert await connection.fetchval("SELECT count(*) > 0 FROM v2_schema_migrations")
        finally:
            await connection.close()


async def test_tables_of_other_owners_and_other_applications_are_left_alone():
    async with supabase_roles(), disposable_database("v2_data_api_") as config:
        connection = await connect_v2(config)
        try:
            await connection.execute("CREATE ROLE v2_data_api_other NOLOGIN")
            await connection.execute("CREATE TABLE v2_owned_elsewhere (id integer)")
            await connection.execute("ALTER TABLE v2_owned_elsewhere OWNER TO v2_data_api_other")
            await connection.execute("CREATE TABLE other_application (id integer)")
            await connection.execute("GRANT SELECT ON other_application TO anon")

            await migrate_v2(config)

            rows = await connection.fetch("SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('v2_owned_elsewhere', 'other_application')")
            assert {row["relname"]: row["relrowsecurity"] for row in rows} == {"v2_owned_elsewhere": False, "other_application": False}
            assert await connection.fetchval("SELECT has_table_privilege('anon', 'other_application', 'SELECT')")
        finally:
            await connection.execute("DROP TABLE IF EXISTS v2_owned_elsewhere")
            await connection.execute("DROP ROLE IF EXISTS v2_data_api_other")
            await connection.close()


async def test_a_database_without_the_supabase_roles_keeps_its_tables_open():
    """The bundled PostgreSQL runs the application under a role that does not own the tables."""
    async with disposable_database("v2_data_api_") as config:
        connection = await connect_v2(config)
        try:
            assert await connection.fetchval("SELECT to_regrole('anon') IS NULL"), "the test server must not have the Supabase roles"
            assert await connection.fetchval("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relrowsecurity") == 0
        finally:
            await connection.close()
