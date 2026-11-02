"""Public visibility of moderated V2 content."""

from fastapi import HTTPException


async def require_visible(connection, kind: str, content_id: int) -> None:
    table = {"product": "v2_products", "recipe": "v2_recipes"}.get(kind)
    if table is None:
        raise ValueError("Unsupported content kind")
    # A private recipe is visible to its author only, through its own routes.
    private = " AND NOT item.private" if kind == "recipe" else ""
    visible = await connection.fetchval(
        f"SELECT EXISTS(SELECT 1 FROM {table} item WHERE item.id=$1{private} "
        "AND NOT EXISTS (SELECT 1 FROM v2_content_withdrawals w "
        "WHERE w.kind=$2 AND w.content_id=item.id))",
        content_id, kind,
    )
    if not visible:
        raise HTTPException(status_code=404, detail="Contenu introuvable.")
