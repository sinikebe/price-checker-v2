"""Public visibility of moderated V2 content."""

from fastapi import HTTPException


async def require_visible(connection, kind: str, content_id: int) -> None:
    table = {"product": "v2_products", "recipe": "v2_recipes"}.get(kind)
    if table is None:
        raise ValueError("Unsupported content kind")
    visible = await connection.fetchval(
        f"SELECT EXISTS(SELECT 1 FROM {table} item WHERE item.id=$1 "
        "AND NOT EXISTS (SELECT 1 FROM v2_content_withdrawals w "
        "WHERE w.kind=$2 AND w.content_id=item.id))",
        content_id, kind,
    )
    if not visible:
        raise HTTPException(status_code=404, detail="Contenu introuvable.")
