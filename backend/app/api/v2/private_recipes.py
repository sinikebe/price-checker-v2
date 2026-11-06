"""Private recipes: seen and changed by their author only, saved at once without review.

They earn no credits. Publishing one sends a copy through the usual review; once an
administrator approves it, the recipe becomes public like any other.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.api.v2.auth import _connect, _secure_write
from app.api.v2.recipes import (
    RecipeInput,
    RecipeUpdate,
    _available_products,
    _check_open_submissions,
    _detail,
    _insert_recipe,
    _replace_ingredients,
    _rewrite_recipe,
    _summary,
    _user,
)
from app.db.v2_json import decoded
from app.services.v2_write_limits import check_write_limit, lock_account_writes

router = APIRouter(prefix="/api/v2/recipes/private", tags=["v2-private-recipes"])

MAX_PRIVATE_RECIPES = 200
_NOT_FOUND = "Recette privée introuvable."


class Publication(BaseModel):
    revision: int = Field(gt=0)


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


async def _owned(connection, recipe_id: int, user: dict, *, lock: bool = False):
    # Never an administrator exception: a private recipe is its author's alone.
    row = await connection.fetchrow(
        "SELECT id,revision FROM v2_recipes WHERE id=$1 AND private AND author_id=$2"
        + (" FOR UPDATE" if lock else ""),
        recipe_id, user["id"],
    )
    if row is None:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    return row


async def _publication(connection, recipe_id: int) -> dict | None:
    """The latest request to publish this recipe that is still waiting or was refused."""
    row = await connection.fetchrow(
        "SELECT id,status,revision FROM v2_recipe_submissions "
        "WHERE recipe_id=$1 AND status IN ('pending','rejected') ORDER BY id DESC LIMIT 1",
        recipe_id,
    )
    if row is None:
        return None
    return {"submission_id": row["id"], "status": row["status"], "revision": row["revision"]}


async def _private_detail(connection, recipe_id: int) -> dict:
    return {
        **await _detail(connection, recipe_id, public=False),
        "publication": await _publication(connection, recipe_id),
    }


async def _pending(connection, recipe_id: int) -> bool:
    return await connection.fetchval(
        "SELECT EXISTS(SELECT 1 FROM v2_recipe_submissions "
        "WHERE recipe_id=$1 AND status='pending')", recipe_id,
    )


@router.get("")
async def my_private_recipes(request: Request, response: Response):
    _no_store(response)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        rows = await connection.fetch(
            "SELECT r.id,r.title,r.description,r.base_servings,r.prep_minutes,"
            "r.cook_minutes,r.updated_at,r.revision,"
            "(SELECT count(*) FROM v2_recipe_ingredients i WHERE i.recipe_id=r.id)::int "
            "AS ingredient_count,"
            "(SELECT s.status FROM v2_recipe_submissions s WHERE s.recipe_id=r.id "
            "AND s.status IN ('pending','rejected') ORDER BY s.id DESC LIMIT 1) AS publication "
            "FROM v2_recipes r WHERE r.author_id=$1 AND r.private "
            "ORDER BY lower(r.title),r.id LIMIT $2",
            user["id"], MAX_PRIVATE_RECIPES,
        )
        return {"items": [_summary(row) for row in rows], "limit": MAX_PRIVATE_RECIPES}
    finally:
        await connection.close()


@router.post("", status_code=201)
async def create_private_recipe(payload: RecipeInput, request: Request, response: Response):
    _secure_write(request)
    _no_store(response)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        await check_write_limit(connection, user)
        async with connection.transaction():
            await lock_account_writes(connection, user)
            count = await connection.fetchval(
                "SELECT count(*) FROM v2_recipes WHERE author_id=$1 AND private", user["id"],
            )
            if count >= MAX_PRIVATE_RECIPES:
                raise HTTPException(
                    status_code=429,
                    detail=f"Vous avez déjà {MAX_PRIVATE_RECIPES} recettes privées : "
                    "supprimez-en une pour en ajouter une autre.",
                )
            recipe_id = await _insert_recipe(connection, user["id"], payload, private=True)
            await _replace_ingredients(connection, recipe_id, payload.ingredients)
        return await _private_detail(connection, recipe_id)
    finally:
        await connection.close()


@router.get("/{recipe_id}")
async def get_private_recipe(recipe_id: int, request: Request, response: Response):
    _no_store(response)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        await _owned(connection, recipe_id, user)
        return await _private_detail(connection, recipe_id)
    finally:
        await connection.close()


@router.put("/{recipe_id}")
async def update_private_recipe(
    recipe_id: int, payload: RecipeUpdate, request: Request, response: Response,
):
    _secure_write(request)
    _no_store(response)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        await check_write_limit(connection, user)
        async with connection.transaction():
            await lock_account_writes(connection, user)
            row = await _owned(connection, recipe_id, user, lock=True)
            if row["revision"] != payload.revision:
                raise HTTPException(status_code=409, detail="La recette a été modifiée ailleurs.")
            if await _pending(connection, recipe_id):
                raise HTTPException(
                    status_code=409,
                    detail="Sa publication attend validation : retirez la demande "
                    "avant de modifier la recette.",
                )
            await _rewrite_recipe(connection, recipe_id, payload, private=True)
            await _replace_ingredients(connection, recipe_id, payload.ingredients)
        return await _private_detail(connection, recipe_id)
    finally:
        await connection.close()


@router.delete("/{recipe_id}", status_code=204)
async def delete_private_recipe(recipe_id: int, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        # Its publication requests go with it (ON DELETE CASCADE).
        removed = await connection.fetchval(
            "DELETE FROM v2_recipes WHERE id=$1 AND private AND author_id=$2 RETURNING id",
            recipe_id, user["id"],
        )
        if removed is None:
            raise HTTPException(status_code=404, detail=_NOT_FOUND)
        return Response(status_code=204)
    finally:
        await connection.close()


@router.post("/{recipe_id}/publish", status_code=202)
async def publish_private_recipe(recipe_id: int, payload: Publication, request: Request):
    """Ask for publication: an administrator reviews a copy, the recipe stays private until then."""
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        await check_write_limit(connection, user)
        async with connection.transaction():
            await lock_account_writes(connection, user)
            row = await _owned(connection, recipe_id, user, lock=True)
            if row["revision"] != payload.revision:
                raise HTTPException(status_code=409, detail="La recette a été modifiée ailleurs.")
            if await _pending(connection, recipe_id):
                raise HTTPException(status_code=409, detail="Sa publication attend déjà validation.")
            await _check_open_submissions(connection, user)
            recipe = await connection.fetchrow(
                "SELECT title,description,base_servings,prep_minutes,cook_minutes,steps "
                "FROM v2_recipes WHERE id=$1", recipe_id,
            )
            ingredients = await connection.fetch(
                "SELECT label,amount,unit,note,optional,product_id,group_name "
                "FROM v2_recipe_ingredients WHERE recipe_id=$1 ORDER BY position", recipe_id,
            )
            content = RecipeInput.model_validate({
                **dict(recipe), "steps": decoded(recipe["steps"]),
                "ingredients": [dict(item) for item in ingredients],
            })
            ids = {item.product_id for item in content.ingredients if item.product_id is not None}
            if ids and await _available_products(connection, ids) != ids:
                raise HTTPException(
                    status_code=422,
                    detail="Un produit de la recette n'est plus disponible : "
                    "choisissez-en un autre avant de la publier.",
                )
            submission_id = await connection.fetchval(
                "INSERT INTO v2_recipe_submissions(author_id,recipe_id,base_revision,payload) "
                "VALUES($1,$2,$3,$4::jsonb) RETURNING id",
                user["id"], recipe_id, row["revision"], content.model_dump_json(),
            )
        return {"submission_id": submission_id, "status": "pending", "recipe_id": recipe_id}
    finally:
        await connection.close()
