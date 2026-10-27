"""Private recipe submissions and explicit administrator publication."""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import Field

from app.api.v2.auth import _connect, _current_user, _secure_write
from app.api.v2.recipes import RecipeInput, _decoded, _detail, _replace_ingredients
from app.services.v2_visibility import require_visible
from app.services.v2_write_limits import (
    MAX_RECIPES,
    check_open_limit,
    check_write_limit,
)

router = APIRouter(prefix="/api/v2/recipes/submissions", tags=["v2-recipe-review"])


class SubmissionUpdate(RecipeInput):
    revision: int = Field(gt=0)


async def _person(connection, request: Request):
    user = await _current_user(connection, request)
    if user is None:
        raise HTTPException(status_code=401, detail="Connexion requise.")
    return user


async def _admin(connection, request: Request):
    user = await _person(connection, request)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Validation réservée à l'administrateur.")
    return user


@router.get("/mine")
async def mine(request: Request, response: Response):
    response.headers["Cache-Control"] = "private, no-store"
    connection = await _connect()
    try:
        user = await _person(connection, request)
        rows = await connection.fetch(
            "SELECT id,recipe_id,payload->>'title' AS title,status,created_at,"
            "reviewed_at,result_recipe_id FROM v2_recipe_submissions "
            "WHERE author_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100",
            user["id"],
        )
        return [dict(row) for row in rows]
    finally:
        await connection.close()


@router.get("/review")
async def review_queue(
    request: Request,
    response: Response,
    limit: int = Query(30, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    response.headers["Cache-Control"] = "private, no-store"
    connection = await _connect()
    try:
        await _admin(connection, request)
        rows = await connection.fetch(
            "SELECT s.id,s.recipe_id,s.base_revision,s.payload,s.created_at,"
            "u.username AS author FROM v2_recipe_submissions s "
            "JOIN v2_users u ON u.id=s.author_id WHERE s.status='pending' "
            "ORDER BY s.created_at,s.id LIMIT $1 OFFSET $2",
            limit, offset,
        )
        return [{**dict(row), "payload": _decoded(row["payload"])} for row in rows]
    finally:
        await connection.close()


@router.get("/{submission_id}")
async def submission_detail(submission_id: int, request: Request, response: Response):
    response.headers["Cache-Control"] = "private, no-store"
    connection = await _connect()
    try:
        user = await _person(connection, request)
        row = await connection.fetchrow(
            "SELECT id,author_id,recipe_id,base_revision,payload,status,revision,"
            "result_recipe_id "
            "FROM v2_recipe_submissions WHERE id=$1", submission_id,
        )
        if row is None or (row["author_id"] != user["id"] and user["role"] != "admin"):
            raise HTTPException(status_code=404, detail="Proposition introuvable.")
        return {**dict(row), "payload": _decoded(row["payload"])}
    finally:
        await connection.close()


@router.put("/{submission_id}")
async def revise_submission(submission_id: int, payload: SubmissionUpdate, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _person(connection, request)
        async with connection.transaction():
            await check_write_limit(connection, user)
            row = await connection.fetchrow(
                "SELECT author_id,recipe_id,base_revision,status,revision "
                "FROM v2_recipe_submissions WHERE id=$1 FOR UPDATE", submission_id,
            )
            if row is None or row["author_id"] != user["id"] or row["status"] not in ("pending", "rejected"):
                raise HTTPException(status_code=404, detail="Proposition modifiable introuvable.")
            if row["revision"] != payload.revision:
                raise HTTPException(status_code=409, detail="La proposition a été modifiée ailleurs.")
            if row["status"] == "rejected":
                await check_open_limit(
                    connection, user, table="v2_recipe_submissions", maximum=MAX_RECIPES,
                )
            if row["recipe_id"] is not None:
                await require_visible(connection, "recipe", row["recipe_id"])
                current = await connection.fetchval(
                    "SELECT revision FROM v2_recipes WHERE id=$1", row["recipe_id"],
                )
                if current != row["base_revision"]:
                    raise HTTPException(status_code=409, detail="La recette publiée a changé.")
            await connection.execute(
                "UPDATE v2_recipe_submissions SET payload=$2::jsonb,status='pending',"
                "created_at=now(),reviewed_at=NULL,reviewer_id=NULL,"
                "revision=revision+1 WHERE id=$1", submission_id,
                payload.model_dump_json(exclude={"revision"}),
            )
        return {"submission_id": submission_id, "status": "pending", "recipe_id": row["recipe_id"], "revision": row["revision"] + 1}
    finally:
        await connection.close()


@router.delete("/{submission_id}", status_code=204)
async def cancel_submission(submission_id: int, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        user = await _person(connection, request)
        removed = await connection.fetchval(
            "DELETE FROM v2_recipe_submissions WHERE id=$1 AND author_id=$2 "
            "AND status='pending' RETURNING id", submission_id, user["id"],
        )
        if removed is None:
            raise HTTPException(status_code=404, detail="Proposition en attente introuvable.")
        return Response(status_code=204)
    finally:
        await connection.close()


@router.post("/{submission_id}/reject")
async def reject_submission(submission_id: int, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        reviewer = await _admin(connection, request)
        row = await connection.fetchrow(
            "UPDATE v2_recipe_submissions SET status='rejected',reviewed_at=now(),"
            "reviewer_id=$2 WHERE id=$1 AND status='pending' RETURNING id",
            submission_id, reviewer["id"],
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Proposition à valider introuvable.")
        return {"id": submission_id, "status": "rejected"}
    finally:
        await connection.close()


@router.post("/{submission_id}/approve")
async def approve_submission(submission_id: int, request: Request):
    _secure_write(request)
    connection = await _connect()
    try:
        reviewer = await _admin(connection, request)
        async with connection.transaction():
            submission = await connection.fetchrow(
                "SELECT * FROM v2_recipe_submissions WHERE id=$1 FOR UPDATE",
                submission_id,
            )
            if submission is None or submission["status"] != "pending":
                raise HTTPException(status_code=404, detail="Proposition à valider introuvable.")
            payload = RecipeInput.model_validate(_decoded(submission["payload"]))
            if submission["recipe_id"] is None:
                recipe_id = await connection.fetchval(
                    "INSERT INTO v2_recipes"
                    "(author_id,title,description,base_servings,prep_minutes,cook_minutes,steps) "
                    "VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id",
                    submission["author_id"], payload.title, payload.description,
                    payload.base_servings, payload.prep_minutes, payload.cook_minutes,
                    json.dumps(payload.steps, ensure_ascii=False),
                )
            else:
                recipe_id = submission["recipe_id"]
                await require_visible(connection, "recipe", recipe_id)
                current = await connection.fetchval(
                    "SELECT revision FROM v2_recipes WHERE id=$1 FOR UPDATE", recipe_id,
                )
                if current != submission["base_revision"]:
                    raise HTTPException(
                        status_code=409,
                        detail="La recette publiée a changé ; examinez la proposition à nouveau.",
                    )
                await connection.execute(
                    "UPDATE v2_recipes SET title=$1,description=$2,base_servings=$3,"
                    "prep_minutes=$4,cook_minutes=$5,steps=$6::jsonb,"
                    "revision=revision+1,updated_at=now() WHERE id=$7",
                    payload.title, payload.description, payload.base_servings,
                    payload.prep_minutes, payload.cook_minutes,
                    json.dumps(payload.steps, ensure_ascii=False),
                    recipe_id,
                )
            await _replace_ingredients(connection, recipe_id, payload.ingredients)
            await connection.execute(
                "UPDATE v2_recipe_submissions SET status='approved',reviewed_at=now(),"
                "reviewer_id=$2,result_recipe_id=$3 WHERE id=$1",
                submission_id, reviewer["id"], recipe_id,
            )
        return {"id": submission_id, "status": "approved", "recipe": await _detail(connection, recipe_id)}
    finally:
        await connection.close()
