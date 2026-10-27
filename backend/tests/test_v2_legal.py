"""Legal pages are installation state, never a source-code fallback."""

import httpx
import pytest

from app.api.v2 import legal
from app.main_v2 import app


@pytest.mark.asyncio
async def test_legal_document_requires_instance_file(tmp_path, monkeypatch):
    monkeypatch.setattr(legal, "_state_dir", lambda: tmp_path)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
        assert (await client.get("/api/v2/legal/mentions")).status_code == 503
        assert (await client.get("/api/v2/legal/unknown")).status_code == 404
        directory = tmp_path / "legal"
        directory.mkdir()
        document = directory / "mentions.md"
        document.write_text("## Hébergement\n\nConfiguration de test.\n")
        response = await client.get("/api/v2/legal/mentions")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert "Configuration de test" in response.text
        document.write_text("  \n")
        assert (await client.get("/api/v2/legal/mentions")).status_code == 503
