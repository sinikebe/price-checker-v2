from __future__ import annotations

from pydantic import BaseModel


class OpenFoodFactsSuggestion(BaseModel):
    """A single product suggestion from OpenFoodFacts."""

    code: str | None = None
    product_name: str | None = None
    brand: str | None = None
    quantity: str | None = None
    ingredients_text: str | None = None
    image_url: str | None = None
    # Nutrition scores, already normalised by the endpoint that builds this
    # the suggestion endpoint: the grade is lowercase a-e or
    # None, never one of OFF's non-grade sentinels ("not-applicable" for wine,
    # "unknown" for pet food -- both verified live), and nova_group is an int
    # or None even though OFF has been known to serve it as a string. Doing
    # that once here, at the boundary, means neither the frontend badge nor
    # the DB write has to re-derive "is this actually a grade?".
    nutriscore_grade: str | None = None
    nova_group: int | None = None
    # Which Nutri-Score algorithm produced ``nutriscore_grade`` ("2021" or
    # "2023"). Only ever populated alongside a real grade -- a version with no
    # grade to qualify describes nothing -- so a client can rely on "grade
    # present => scale known" and never compare two grades from different
    # scales by accident.
    nutriscore_version: str | None = None


class OpenFoodFactsSearchResponse(BaseModel):
    """Response wrapper for OpenFoodFacts search results."""

    suggestions: list[OpenFoodFactsSuggestion]
