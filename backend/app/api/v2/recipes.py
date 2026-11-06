"""V2 recipes: precise products or reusable catalogue groups per ingredient."""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, model_validator

from app.api.v2.auth import _connect, _current_user, _secure_write
from app.core.paris_time import paris_day
from app.db.v2_json import decoded
from app.db.v2_sql import MAX_BIGINT
from app.services.v2_visibility import require_visible
from app.services.v2_write_limits import (
    MAX_RECIPES,
    check_open_limit,
    check_write_limit,
    lock_account_writes,
)

router = APIRouter(prefix="/api/v2/recipes", tags=["v2-recipes"])

Unit = Literal["g", "kg", "ml", "cl", "l", "piece"]


class IngredientInput(BaseModel):
    label: str = Field(min_length=1, max_length=200)
    amount: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=3)
    unit: Unit | None = None
    note: str = Field(default="", max_length=1000)
    optional: bool = False
    product_id: int | None = Field(default=None, gt=0, le=MAX_BIGINT)
    group_name: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def validate_target(self):
        self.label = self.label.strip()
        self.note = self.note.strip()
        # A name of spaces only is no group: it would fail the database check later.
        self.group_name = (self.group_name or "").strip() or None
        if not self.label:
            raise ValueError("Le nom de l'ingrédient est nécessaire.")
        if (self.product_id is None) == (self.group_name is None):
            raise ValueError("Choisissez un produit ou un groupe, pas les deux.")
        if (self.amount is None) != (self.unit is None):
            raise ValueError("Quantité et unité doivent être renseignées ensemble.")
        return self


class RecipeInput(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=10000)
    base_servings: Decimal = Field(gt=0, max_digits=12, decimal_places=3)
    prep_minutes: int | None = Field(default=None, ge=0, le=100000)
    cook_minutes: int | None = Field(default=None, ge=0, le=100000)
    steps: list[str] = Field(min_length=1, max_length=200)
    ingredients: list[IngredientInput] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def validate_text(self):
        self.title = self.title.strip()
        self.description = self.description.strip()
        self.steps = [step.strip() for step in self.steps]
        if not self.title or any(not step or len(step) > 5000 for step in self.steps):
            raise ValueError(
                "Titre et étapes non vides nécessaires (5 000 caractères max)."
            )
        return self


class RecipeUpdate(RecipeInput):
    revision: int = Field(gt=0)


async def _user(connection, request):
    user = await _current_user(connection, request)
    if user is None:
        raise HTTPException(
            status_code=401, detail="Connectez-vous pour modifier une recette."
        )
    return user


async def _detail(connection, recipe_id: int, *, public: bool = True):
    """A recipe with its ingredients. A private one is read only by its own routes (public=False)."""
    if public:
        await require_visible(connection, "recipe", recipe_id)
    recipe = await connection.fetchrow(
        "SELECT * FROM v2_recipes WHERE id=$1",
        recipe_id,
    )
    if recipe is None:
        raise HTTPException(status_code=404, detail="Recette introuvable.")
    ingredients = await connection.fetch(
        "SELECT i.*, p.data AS product_data FROM v2_recipe_ingredients i "
        "LEFT JOIN v2_products p ON p.id=i.product_id "
        "AND NOT EXISTS (SELECT 1 FROM v2_content_withdrawals w "
        "WHERE w.kind='product' AND w.content_id=p.id) "
        "WHERE i.recipe_id=$1 ORDER BY i.position",
        recipe_id,
    )
    return {
        "id": recipe["id"],
        "title": recipe["title"],
        "description": recipe["description"],
        "base_servings": str(recipe["base_servings"]),
        "prep_minutes": recipe["prep_minutes"],
        "cook_minutes": recipe["cook_minutes"],
        "steps": decoded(recipe["steps"]),
        "revision": recipe["revision"],
        "private": recipe["private"],
        "created_at": paris_day(recipe["created_at"]),
        "updated_at": paris_day(recipe["updated_at"]),
        "ingredients": [
            {
                "id": item["id"],
                "label": item["label"],
                "amount": str(item["amount"]) if item["amount"] is not None else None,
                "unit": item["unit"],
                "note": item["note"],
                "optional": item["optional"],
                "product_id": item["product_id"] if item["product_data"] else None,
                "group_name": item["group_name"],
                "product": decoded(item["product_data"])
                if item["product_data"]
                else None,
            }
            for item in ingredients
        ],
    }


def _summary(row) -> dict:
    """A recipe list item: its row with JSON-friendly servings and last-change day."""
    return {**dict(row), "base_servings": str(row["base_servings"]),
            "updated_at": paris_day(row["updated_at"])}


async def _available_products(connection, ids: set[int]) -> set[int]:
    """The ids among these that name a product that exists and is not withdrawn."""
    return {row["id"] for row in await connection.fetch(
        "SELECT p.id FROM v2_products p WHERE p.id=ANY($1::bigint[]) "
        "AND NOT EXISTS (SELECT 1 FROM v2_content_withdrawals w "
        "WHERE w.kind='product' AND w.content_id=p.id)", list(ids)
    )}


async def _replace_ingredients(
    connection, recipe_id: int, ingredients: list[IngredientInput]
):
    ids = {item.product_id for item in ingredients if item.product_id is not None}
    if ids and await _available_products(connection, ids) != ids:
        raise HTTPException(
            status_code=422, detail="Produit référencé introuvable."
        )
    await connection.execute(
        "DELETE FROM v2_recipe_ingredients WHERE recipe_id=$1", recipe_id
    )
    await connection.executemany(
        "INSERT INTO v2_recipe_ingredients "
        "(recipe_id, position, label, amount, unit, note, "
        "optional, product_id, group_name) "
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [(recipe_id, position, item.label, item.amount, item.unit, item.note,
          item.optional, item.product_id, item.group_name)
         for position, item in enumerate(ingredients)],
    )


async def _insert_recipe(connection, author_id: int, payload: RecipeInput, *, private: bool) -> int:
    """Save a new recipe row (its ingredients are written separately) and return its id."""
    return await connection.fetchval(
        "INSERT INTO v2_recipes(author_id,title,description,base_servings,"
        "prep_minutes,cook_minutes,steps,private) "
        "VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id",
        author_id, payload.title, payload.description, payload.base_servings,
        payload.prep_minutes, payload.cook_minutes,
        json.dumps(payload.steps, ensure_ascii=False), private,
    )


async def _rewrite_recipe(connection, recipe_id: int, payload: RecipeInput, *, private: bool) -> None:
    """Replace a recipe row's content and move it to its next revision."""
    await connection.execute(
        "UPDATE v2_recipes SET title=$1,description=$2,base_servings=$3,"
        "prep_minutes=$4,cook_minutes=$5,steps=$6::jsonb,private=$7,"
        "revision=revision+1,updated_at=now() WHERE id=$8",
        payload.title, payload.description, payload.base_servings,
        payload.prep_minutes, payload.cook_minutes,
        json.dumps(payload.steps, ensure_ascii=False), private, recipe_id,
    )


async def _check_open_submissions(connection, user) -> None:
    """Refuse a new waiting submission past the author's limit (administrators have none)."""
    await check_open_limit(
        connection, user, table="v2_recipe_submissions", maximum=MAX_RECIPES,
    )


async def _has_pending_edit(connection, author_id: int, recipe_id: int) -> bool:
    """Whether this author already has a change of this recipe waiting for review."""
    return await connection.fetchval(
        "SELECT EXISTS(SELECT 1 FROM v2_recipe_submissions "
        "WHERE author_id=$1 AND recipe_id=$2 AND status='pending')",
        author_id, recipe_id,
    )


@router.get("")
async def list_recipes(
    q: str = Query(default="", max_length=100),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
):
    connection = await _connect()
    try:
        pattern = (
            "%"
            + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            + "%"
        )
        total = await connection.fetchval(
            "SELECT count(*) FROM v2_recipes r WHERE r.title ILIKE $1 ESCAPE '\\' "
            "AND NOT r.private AND NOT EXISTS (SELECT 1 FROM v2_content_withdrawals w "
            "WHERE w.kind='recipe' AND w.content_id=r.id)", pattern
        )
        rows = await connection.fetch(
            "SELECT r.id, r.title, r.description, r.base_servings, "
            "r.prep_minutes, r.cook_minutes, r.updated_at, r.revision, "
            "count(i.id)::int AS ingredient_count FROM v2_recipes r "
            "LEFT JOIN v2_recipe_ingredients i ON i.recipe_id=r.id "
            "WHERE r.title ILIKE $1 ESCAPE '\\' AND NOT r.private "
            "AND NOT EXISTS (SELECT 1 FROM v2_content_withdrawals w "
            "WHERE w.kind='recipe' AND w.content_id=r.id) "
            "GROUP BY r.id ORDER BY lower(r.title), r.id LIMIT $2 OFFSET $3",
            pattern,
            page_size,
            (page - 1) * page_size,
        )
        return {
            "items": [_summary(row) for row in rows],
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    finally:
        await connection.close()


@router.get("/{recipe_id}")
async def get_recipe(recipe_id: int):
    connection = await _connect()
    try:
        return await _detail(connection, recipe_id)
    finally:
        await connection.close()


@router.get("/{recipe_id}/access")
async def recipe_access(recipe_id: int, request: Request, response: Response):
    """Private edit permission, never included in the public recipe cache."""
    response.headers["Cache-Control"] = "private, no-store"
    connection = await _connect()
    try:
        user = await _user(connection, request)
        await require_visible(connection, "recipe", recipe_id)
        row = await connection.fetchrow(
            "SELECT author_id FROM v2_recipes WHERE id=$1", recipe_id
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Recette introuvable.")
        return {"can_edit": user["role"] == "admin" or row["author_id"] == user["id"]}
    finally:
        await connection.close()


@router.post("", status_code=202)
async def create_recipe(payload: RecipeInput, request: Request):
    """Submit a new recipe privately; only a reviewer may publish it."""
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        await check_write_limit(connection, user)
        async with connection.transaction():
            await lock_account_writes(connection, user)
            await _check_open_submissions(connection, user)
            submission_id = await connection.fetchval(
                "INSERT INTO v2_recipe_submissions(author_id,payload) "
                "VALUES($1,$2::jsonb) RETURNING id",
                user["id"], payload.model_dump_json(),
            )
        return {"submission_id": submission_id, "status": "pending"}
    finally:
        await connection.close()


@router.put("/{recipe_id}", status_code=202)
async def update_recipe(recipe_id: int, payload: RecipeUpdate, request: Request):
    """Keep the approved version visible while its replacement is reviewed."""
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        await check_write_limit(connection, user)
        async with connection.transaction():
            await lock_account_writes(connection, user)
            await require_visible(connection, "recipe", recipe_id)
            existing = await connection.fetchrow(
                "SELECT author_id,revision FROM v2_recipes WHERE id=$1 FOR UPDATE",
                recipe_id,
            )
            if existing is None:
                raise HTTPException(status_code=404, detail="Recette introuvable.")
            if existing["author_id"] != user["id"] and user["role"] != "admin":
                raise HTTPException(status_code=403, detail="Recette d'un autre auteur.")
            if existing["revision"] != payload.revision:
                raise HTTPException(status_code=409, detail="La recette a été modifiée ailleurs.")
            if await _has_pending_edit(connection, user["id"], recipe_id):
                raise HTTPException(status_code=409, detail="Une modification attend déjà validation.")
            await _check_open_submissions(connection, user)
            submission_id = await connection.fetchval(
                "INSERT INTO v2_recipe_submissions"
                "(author_id,recipe_id,base_revision,payload) "
                "VALUES($1,$2,$3,$4::jsonb) RETURNING id",
                user["id"], recipe_id, payload.revision,
                payload.model_dump_json(exclude={"revision"}),
            )
        return {"submission_id": submission_id, "status": "pending", "recipe_id": recipe_id}
    finally:
        await connection.close()


@router.delete("/{recipe_id}", status_code=204)
async def delete_recipe(recipe_id: int, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _user(connection, request)
        # A private recipe is deleted through its own route, by its author only.
        row = await connection.fetchrow(
            "SELECT author_id FROM v2_recipes WHERE id=$1 AND NOT private", recipe_id
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Recette introuvable.")
        if row["author_id"] != user["id"] and user["role"] != "admin":
            raise HTTPException(status_code=403, detail="Recette d'un autre auteur.")
        await connection.execute("DELETE FROM v2_recipes WHERE id=$1", recipe_id)
    finally:
        await connection.close()
