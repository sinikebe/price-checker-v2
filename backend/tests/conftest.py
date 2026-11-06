"""Shared test setup: a strict journal, a visitor allowance per test, and disposable databases.

The journal refuses, in tests, any event or value that is not in its registry.
"""
import os

os.environ.setdefault("PRICE_CHECKER_V2_LOG_STRICT", "1")

import contextlib  # noqa: E402
import json  # noqa: E402
import secrets  # noqa: E402
from pathlib import Path  # noqa: E402

import pytest  # noqa: E402

from app.api.v2 import credits as _credits  # noqa: E402
from app.db.v2_migrations import connect_v2, migrate_v2  # noqa: E402

# The real keying (an HMAC of the client address), for the tests of the visitor allowance itself.
REAL_VISITOR_KEY = _credits._visitor_key

requires_v2_db = pytest.mark.skipif(
    not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required"
)


@contextlib.asynccontextmanager
async def disposable_database(prefix: str, *, migrate: bool = True):
    """Create `prefix` + a random suffix from the base config, yield its config, then drop it.

    Each caller gets its own database, so test runs in parallel worktrees never share one.
    With `migrate=False` the database stays empty, for tests that build an older schema first.
    """
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = prefix + secrets.token_hex(5)
    admin = await connect_v2(base)
    try:
        await admin.execute('CREATE DATABASE "' + database + '"')
    finally:
        await admin.close()
    config = {**base, "database": database}
    try:
        if migrate:
            await migrate_v2(config)
        yield config
    finally:
        admin = await connect_v2(base)
        try:
            await admin.execute('DROP DATABASE "' + database + '" WITH (FORCE)')
        finally:
            await admin.close()


@pytest.fixture(autouse=True)
def separate_visitor_allowance(monkeypatch):
    """Every test reads prices as its own visitor: the daily allowance is not shared across the suite."""
    key = secrets.token_hex(32)
    monkeypatch.setattr(_credits, "_visitor_key", lambda _request: key)
