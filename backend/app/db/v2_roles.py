"""Provision and verify the limited role of the bundled PostgreSQL instance."""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path

from app.api.v2.setup import _read_config
from app.db.v2_migrations import connect_v2

_NAME = re.compile(r"[a-z][a-z0-9_]*")
_PASSWORD = re.compile(r"[0-9a-f]{64}")


async def main() -> None:
    config = _read_config()
    if config is None:
        raise ValueError("Database configuration required")
    connection = await connect_v2(config)
    try:
        if os.getenv("V2_ROLE_PROBE") == "1":
            role = await connection.fetchval("SELECT current_user")
            limited = await connection.fetchval(
                "SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole "
                "FROM pg_roles WHERE rolname=current_user"
            )
            can_write = all([
                await connection.fetchval(
                    "SELECT has_table_privilege(current_user, 'v2_users', $1)",
                    privilege,
                )
                for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE")
            ])
            if role != config["username"] or not limited or not can_write:
                raise ValueError("Application role lacks permissions or is privileged")
            print("Bundled database application role is limited and writable.")
            return
        database = config["database"]
        if config["username"] != database or not _NAME.fullmatch(database):
            raise ValueError("Migration owner must be the bundled database owner")
        role = database + "_app"
        password = Path("/migration/app-password").read_text().strip()
        if not _PASSWORD.fullmatch(password):
            raise ValueError("Invalid generated application password")
        if not await connection.fetchval(
            "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1)", role
        ):
            await connection.execute(f'CREATE ROLE "{role}" LOGIN')
        await connection.execute(
            f'ALTER ROLE "{role}" WITH LOGIN PASSWORD \'{password}\' '
            "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION"
        )
        await connection.execute(f'GRANT CONNECT ON DATABASE "{database}" TO "{role}"')
        await connection.execute(f'GRANT USAGE ON SCHEMA public TO "{role}"')
        await connection.execute(
            f'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES '
            f'IN SCHEMA public TO "{role}"'
        )
        await connection.execute(
            f'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "{role}"'
        )
        await connection.execute(
            f'ALTER DEFAULT PRIVILEGES FOR ROLE "{database}" IN SCHEMA public '
            f'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "{role}"'
        )
        await connection.execute(
            f'ALTER DEFAULT PRIVILEGES FOR ROLE "{database}" IN SCHEMA public '
            f'GRANT USAGE, SELECT ON SEQUENCES TO "{role}"'
        )
    finally:
        await connection.close()


if __name__ == "__main__":
    asyncio.run(main())
