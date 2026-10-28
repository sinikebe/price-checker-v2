"""The published API reference is generated from the served FastAPI routes."""

from importlib.metadata import version as package_version

import httpx
import pytest
from fastapi.routing import APIRoute

from app.main_v2 import app


@pytest.mark.asyncio
async def test_openapi_docs_match_served_routes():
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/v2/openapi.json")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/json")
        schema = response.json()
        assert schema["info"]["version"] == package_version("price-checker-v2-backend")
        docs = await client.get("/api/v2/docs")
        assert docs.status_code == 200
        assert '/api/v2/openapi.json' in docs.text
        assert (await client.get("/openapi.json")).status_code == 404
        assert (await client.get("/docs")).status_code == 404

    # FastAPI may keep included routers as deferred _IncludedRouter objects.
    # Inspect their original route definitions, not only direct app.routes.
    api_routes = [
        (route, getattr(item, "include_context", None))
        for item in app.routes
        for route in (
            item.original_router.routes if hasattr(item, "original_router") else [item]
        )
        if isinstance(route, APIRoute)
    ]
    served = {
        (f"{context.prefix if context else ''}{route.path}", method.lower())
        for route, context in api_routes
        if route.path.startswith("/api/v2/")
        for method in route.methods
    }
    documented = {
        (path, method)
        for path, operations in schema["paths"].items()
        for method in operations
        if method in {"get", "post", "put", "patch", "delete"}
    }
    assert documented == served
    assert len(documented) == len({
        schema["paths"][path][method]["operationId"]
        for path, method in documented
    })
    assert "/api/v2/docs" not in schema["paths"]
