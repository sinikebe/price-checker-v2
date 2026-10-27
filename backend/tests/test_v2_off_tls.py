"""The local PostgreSQL certificate must not replace public HTTPS roots for OFF."""

import pytest

from app.services.openfoodfacts_client import aclose_off_client, get_off_client


@pytest.mark.asyncio
async def test_off_client_ignores_database_ssl_cert_file(monkeypatch):
    await aclose_off_client()
    monkeypatch.setenv("SSL_CERT_FILE", "/definitely/not/a/public/ca-bundle.pem")
    try:
        client = await get_off_client()
        assert client is not None
    finally:
        await aclose_off_client()
