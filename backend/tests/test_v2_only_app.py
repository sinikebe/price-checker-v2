"""The public entrypoint exposes only the application API."""

import httpx
import pytest
from app.main_v2 import app


@pytest.mark.asyncio
async def test_v2_only_entrypoint_routes():
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        assert (await client.get("/health")).status_code == 200
        assert (await client.get("/api/v2/setup/status")).status_code == 200
    paths = {getattr(route, "path", "") for route in app.routes}
    assert all(path.startswith("/api/v2") for path in paths if path.startswith("/api/"))
