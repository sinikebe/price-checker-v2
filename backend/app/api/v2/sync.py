"""Small, constant-time collection revisions for PWA refresh checks."""

from fastapi import APIRouter, Request, Response

from app.api.v2.auth import _connect, _current_user

router = APIRouter(prefix="/api/v2/sync", tags=["v2-sync"])


@router.get("/versions")
async def versions(request: Request, response: Response):
    connection = await _connect()
    try:
        rows = await connection.fetch(
            "SELECT collection, revision FROM v2_pwa_versions"
        )
        versions = {row["collection"]: row["revision"] for row in rows}
        user = await _current_user(connection, request)
        versions["user_id"] = user["id"] if user else None
        versions["basket"] = (
            await connection.fetchval(
                "SELECT revision FROM v2_user_baskets WHERE user_id=$1", user["id"]
            ) or 0
        ) if user else 0
    finally:
        await connection.close()
    etag_user = versions["user_id"] if user else "anon"
    etag = (
        f'"u{etag_user}-p{versions["products"]}'
        f'-r{versions["recipes"]}-b{versions["basket"]}"'
    )
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["ETag"] = etag
    if request.headers.get("if-none-match") == etag:
        return Response(
            status_code=304,
            headers={"Cache-Control": "private, no-store", "ETag": etag},
        )
    return versions
