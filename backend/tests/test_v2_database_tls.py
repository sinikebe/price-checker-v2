"""Database setup and runtime must use the right CA for each provider."""

import pytest
from app.api.v2.setup import _test_connection
from app.db.v2_migrations import ssl_option


def test_database_ca_selection(monkeypatch):
    seen = []

    def context(*, cafile=None):
        seen.append(cafile)
        return object()

    monkeypatch.setattr("app.db.v2_migrations.ssl.create_default_context", context)
    for provider, host, expected_ca in (
        ("postgres", "db", "/certs/server.crt"),
        ("supabase", "aws-0-eu-west-1.pooler.supabase.com", "/certs/supabase-ca.crt"),
        ("postgres", "external.example", None),
    ):
        ssl_option({"tls_mode": "verify-full", "provider": provider, "host": host})
        assert seen[-1] == expected_ca


@pytest.mark.asyncio
async def test_setup_connection_uses_database_ca(monkeypatch):
    expected_context = object()
    monkeypatch.setattr("app.api.v2.setup.ssl_option", lambda config: expected_context)
    seen = []

    class Connection:
        async def fetchval(self, query):
            assert query == "SELECT 1"
            return 1

        async def close(self):
            pass

    async def connect(**kwargs):
        seen.append(kwargs)
        return Connection()

    monkeypatch.setattr("app.api.v2.setup.asyncpg.connect", connect)
    await _test_connection({
        "provider": "supabase", "host": "pooler.supabase.com",
        "port": 5432, "username": "postgres.project", "password": "test",
        "database": "postgres", "tls_mode": "verify-full",
    })
    assert seen[0]["ssl"] is expected_context
