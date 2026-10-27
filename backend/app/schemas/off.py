"""Wire shapes for the full OpenFoodFacts record shown on a product page.

The response is a list of ordered, titled sections rather than the raw OFF
document. That is the whole point of the endpoint: the document has 262
top-level keys, and handing it to the client unchanged would move the job of
deciding what any of them mean into the browser, in TypeScript, where it is
harder to test and impossible to reuse.

Every value is reduced to one of a handful of ``kind``s below, so the frontend
renders by kind and never has to know that ``labels`` is comma-separated while
``labels_tags`` is a list while ``packagings`` is a list of dicts. Adding a
field to a section therefore costs nothing on the client.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

# How the client should render a value. Deliberately a small closed set: each
# one has exactly one renderer, so a new field can only ever look like something
# that already has a tested appearance.
#
#   text      a string, shown as-is
#   tags      a list of short strings, shown as chips (OFF's comma-joined
#             strings and its ``*_tags`` lists both reduce to this)
#   number    an int/float, right-aligned
#   link      an absolute URL, shown as an anchor
#   image     an absolute image URL, shown as a picture
#   timestamp a moment in time (OFF sends Unix seconds; converted here so the
#             client never has to guess a unit)
#   json      anything structurally rich enough that flattening would lose
#             information -- ``packagings``, ``ingredients_analysis`` -- shown
#             in a collapsible pretty-printed block
OffFieldKind = Literal["text", "tags", "number", "link", "image", "timestamp", "json"]


class OffField(BaseModel):
    """One labelled value inside a section."""

    # The original OFF key. Kept alongside the human label because the label is
    # translated and the key is not: it is what a user needs in order to look
    # the field up in OFF's own documentation, and what makes a bug report
    # ("`nova_groups` is wrong") unambiguous.
    key: str
    label: str
    kind: OffFieldKind
    # Exactly one of these is populated, chosen by ``kind``. Modelled as
    # separate typed fields rather than a single ``Any`` so the client gets real
    # types instead of a union it has to narrow by hand at every use site.
    text: str | None = None
    tags: list[str] = Field(default_factory=list)
    number: float | None = None
    url: str | None = None
    timestamp: datetime | None = None
    json_value: Any = None


class OffNutriment(BaseModel):
    """One row of the nutrition table.

    OFF stores each nutrient as up to six flat keys (``salt``, ``salt_100g``,
    ``salt_serving``, ``salt_unit``, ``salt_value``, ``salt_modifier``). They are
    regrouped here into the row a human reads, because a 60-row list of
    ``salt_unit``-style keys is data, not a nutrition table.
    """

    key: str
    label: str
    per_100g: float | None = None
    per_serving: float | None = None
    unit: str | None = None
    # OFF's ``_modifier`` -- "<", "~", ">=" etc. A trace value recorded as
    # "< 0.5" must not be shown as a flat 0.5, which would read as a measurement.
    modifier: str | None = None
    # OFF's own coarse assessment for the four nutrients it grades
    # (``nutrient_levels``): "low" | "moderate" | "high". Null for everything
    # else -- most nutrients have no such judgement and inventing one would be
    # editorialising.
    level: str | None = None


class OffImage(BaseModel):
    key: str
    label: str
    url: str
    thumb_url: str | None = None


class OffSection(BaseModel):
    """One titled block on the page.

    ``kind`` selects the renderer. ``fields`` is the common case; ``nutriments``
    and ``images`` exist because a table and a gallery are genuinely different
    shapes that would be unreadable as label/value pairs.
    """

    id: str
    title: str
    kind: Literal["fields", "nutriments", "images", "raw"] = "fields"
    fields: list[OffField] = Field(default_factory=list)
    nutriments: list[OffNutriment] = Field(default_factory=list)
    images: list[OffImage] = Field(default_factory=list)
    # Populated only for ``kind == "raw"``: the keys no curated section claimed.
    # See app/services/off_presenter.py -- this is what makes "show all of it"
    # true by construction rather than by a maintainer remembering.
    raw: dict[str, Any] = Field(default_factory=dict)
    # Keep the external sheet compact until a reader chooses a section.
    collapsed: bool = True
