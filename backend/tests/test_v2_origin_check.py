"""Writes from another site are refused for cookie sessions; a bearer token is its own proof."""
import pytest
from app.api.v2.auth import _check_origin, _current_user
from fastapi import HTTPException
from starlette.requests import Request


def request(headers: dict[str, str]) -> Request:
    scope = {"type": "http", "method": "POST", "scheme": "https", "server": ("price.example", 443), "path": "/api/v2/x",
             "query_string": b"", "headers": [(k.lower().encode(), v.encode()) for k, v in {"host": "price.example", **headers}.items()]}
    return Request(scope)


def test_a_cookie_session_still_refuses_another_origin_and_cross_site_requests():
    _check_origin(request({}))
    _check_origin(request({"origin": "https://price.example"}))
    for headers in ({"origin": "https://evil.example"}, {"origin": "chrome-extension://abc"},
                    {"sec-fetch-site": "cross-site"}, {"origin": "https://evil.example", "cookie": "pc_v2_session=x"}):
        with pytest.raises(HTTPException) as refused:
            _check_origin(request(headers))
        assert refused.value.status_code == 403, headers


def test_a_request_with_a_bearer_header_is_not_checked_for_origin():
    for headers in ({"authorization": "Bearer pcv2_x", "origin": "chrome-extension://abc"},
                    {"authorization": "Bearer pcv2_x", "sec-fetch-site": "cross-site"}):
        _check_origin(request(headers))


@pytest.mark.asyncio
async def test_a_bearer_header_never_falls_back_to_the_cookie():
    """Skipping the origin check is safe only because a bearer header is judged on the token alone."""
    class NoDatabase:
        async def fetchrow(self, *_args):
            raise AssertionError("an invalid token must be refused before any lookup")
    for authorization in ("Bearer", "Bearer short", "Basic abc", "garbage"):
        with pytest.raises(HTTPException) as refused:
            await _current_user(NoDatabase(), request({"authorization": authorization, "cookie": "pc_v2_session=" + "a" * 43}))
        assert refused.value.status_code == 401
