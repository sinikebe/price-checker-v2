"""The published API reference is generated from the served FastAPI routes."""

import re
from importlib.metadata import version as package_version

import httpx
import pytest
from fastapi.routing import APIRoute

from app.main_v2 import BEARER_OPERATIONS, OPTIONAL_BEARER_OPERATIONS, app


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
        assert schema["components"]["securitySchemes"]["PersonalApiToken"]["scheme"] == "bearer"
        assert schema["paths"]["/api/v2/auth/token"]["get"]["security"] == [
            {"PersonalApiToken": []}
        ]
        for method, path in BEARER_OPERATIONS:
            expected = ([{}, {"PersonalApiToken": []}]
                        if (method, path) in OPTIONAL_BEARER_OPERATIONS
                        else [{"PersonalApiToken": []}])
            assert schema["paths"][path][method.lower()]["security"] == expected
        assert "security" not in schema["paths"]["/api/v2/account/security/tokens"]["get"]
        assert "security" not in schema["paths"]["/api/v2/setup/hostname"]["get"]
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
    # OpenAPI documents `{name:path}` as `{name}`: compare without the path converter.
    served = {
        (re.sub(r"\{(\w+):\w+\}", r"{\1}", f"{context.prefix if context else ''}{route.path}"), method.lower())
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
