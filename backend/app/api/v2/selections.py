"""Selections: one basket line that combines any parts of the catalogue.

A comparable group answers "orange juice, organic"; a selection answers "any organic fruit juice":
the products of several groups, ensembles, families or departments (and single products), minus
what is excluded, optionally kept to products whose text contains given words. It lives in the
basket only; the catalogue does not change.

The shape is kept small on purpose, so that a person, a script or a small language model can write
it without help:

    {"kind": "selection", "name": "Jus de fruits bio",
     "include": [{"family": "Jus de fruits"}], "words": ["bio"]}

Each member names one level: `product` (an id), `group`, `scope` (an ensemble), `family` or
`department`. An ensemble or a family may be narrowed with the levels above it when the same name is
used elsewhere: {"scope": "Pâtes sèches", "family": "Pâtes, riz et céréales"}. Names are matched
without regard to case or accents.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.db.v2_sql import CATEGORY, CURRENT_PRODUCT, DISPLAY_ORDER, MAX_BIGINT
from app.services.v2_catalogue_hierarchy import UNCATEGORIZED, fold

MAX_MEMBERS = 20  # parts included, and as many excluded
MAX_WORDS = 5
Level = Literal["product", "group", "scope", "family", "department"]


def _fold_sql(expression: str) -> str:
    return (f"translate(replace(replace(lower({expression}),'œ','oe'),'æ','ae'),"
            "'àâäáãåāçéèêëēíìîïñóòôöõúùûüýÿ’‘','aaaaaaaceeeeeiiiinooooouuuuyy''''')")


def _name(value: str | None) -> str | None:
    if value is None:
        return None
    value = " ".join(value.split())
    if not value:
        raise ValueError("Nom vide.")
    return value


class Member(BaseModel):
    """One part of a selection: give exactly one of product, group, scope, family or department.
    A scope may add its family and department, a family its department, to tell apart equal names."""

    product: int | None = Field(default=None, ge=1, le=MAX_BIGINT)
    group: str | None = Field(default=None, min_length=1, max_length=100)
    scope: str | None = Field(default=None, min_length=1, max_length=80)
    family: str | None = Field(default=None, min_length=1, max_length=80)
    department: str | None = Field(default=None, min_length=1, max_length=80)
    _names = field_validator("group", "scope", "family", "department")(_name)

    @model_validator(mode="after")
    def one_level(self):
        if self.product is not None or self.group is not None:
            others = [key for key in ("group", "scope", "family", "department") if getattr(self, key) is not None]
            if self.product is not None and others or self.group is not None and len(others) > 1:
                raise ValueError("Un produit ou un groupe se donne seul : {\"product\": 12} ou {\"group\": \"Nom\"}.")
        elif self.scope is None and self.family is None and self.department is None:
            raise ValueError("Indiquez product, group, scope, family ou department.")
        return self

    @property
    def level(self) -> Level:
        """The most precise level given: what the member names."""
        if self.product is not None:
            return "product"
        if self.group is not None:
            return "group"
        if self.scope is not None:
            return "scope"
        if self.family is not None:
            return "family"
        return "department"


class Selection(BaseModel):
    """What a selection line holds, apart from its kind and the basket options."""

    name: str = Field(min_length=1, max_length=100, description="Le nom affiché dans le panier.")
    include: list[Member] = Field(min_length=1, max_length=MAX_MEMBERS)
    exclude: list[Member] = Field(default_factory=list, max_length=MAX_MEMBERS)
    words: list[str] = Field(default_factory=list, max_length=MAX_WORDS, description=(
        "Mots que chaque produit doit contenir (nom, marque, nom commercial, groupe, étiquettes), "
        "sans tenir compte des majuscules ni des accents."))
    _clean_name = field_validator("name")(_name)

    @field_validator("words")
    @classmethod
    def clean_words(cls, values: list[str]) -> list[str]:
        cleaned = []
        for value in values:
            value = fold(value)
            if not value or len(value) > 40:
                raise ValueError("Chaque mot fait de 1 à 40 caractères.")
            if value not in cleaned:
                cleaned.append(value)
        return cleaned

    def spec(self) -> dict:
        """What is stored with a shared basket line (the name is the line's label)."""
        return self.model_dump(mode="json", exclude={"name", "kind"}, exclude_none=True)


class SelectionRef(Selection):
    kind: Literal["selection"]


# The text a word must appear in. Tags are matched in their stored form, which holds their words.
_WORD_TEXT = _fold_sql("concat_ws(' ', p.data->>'brand', p.data->>'name', p.data->>'commercial_name', "
                       f"{CATEGORY}, p.data->>'tags')")


def _member_sql(member: Member, params: list, product_ids: dict[int, int | None]) -> str:
    def param(value) -> str:
        params.append(value)
        return f"${len(params)}"

    def same(column: str, value: str, default: str | None = None) -> str:
        column = f"COALESCE({column},'{default}')" if default else column
        return f"{_fold_sql(column)}={param(fold(value))}"

    if member.product is not None:
        current = product_ids.get(member.product)
        return f"p.id={param(current)}" if current else "false"
    if member.group is not None:
        return same(CATEGORY, member.group)
    # Groups not classified yet sit under "À classer", as the catalogue shows them.
    parts = []
    if member.department is not None:
        parts.append(same("c.department", member.department, UNCATEGORIZED))
    if member.family is not None:
        parts.append(same("c.family", member.family, UNCATEGORIZED))
    if member.scope is not None:
        parts.append(same("c.comparison_scope", member.scope))
    return "(" + " AND ".join(parts) + ")"


def selection_where(selection: Selection, params: list, product_ids: dict[int, int | None]) -> str:
    """The condition on `p` (a product) and `c` (its group's classification) for this selection."""
    include = " OR ".join(_member_sql(member, params, product_ids) for member in selection.include)
    where = f"({include})"
    if selection.exclude:
        exclude = " OR ".join(_member_sql(member, params, product_ids) for member in selection.exclude)
        where += f" AND NOT ({exclude})"
    for word in selection.words:
        params.append(word)
        where += f" AND strpos({_WORD_TEXT}, ${len(params)}) > 0"
    return where


FROM = (f"FROM v2_products p LEFT JOIN v2_catalogue_classifications c ON c.group_key=lower({CATEGORY}) "
        f"WHERE {CURRENT_PRODUCT}")


async def current_ids(connection, selection: Selection, current_products) -> dict[int, int | None]:
    """The product each product member currently stands for (after merges and new versions), None when
    it is withdrawn or gone. `current_products` (basket._current_products, passed in because the basket
    imports this module) resolves them all at once."""
    wanted = [member.product for member in [*selection.include, *selection.exclude] if member.product is not None]
    if not wanted:
        return {}
    rows = await current_products(connection, wanted)
    return {product_id: (row["id"] if row else None) for product_id, row in rows.items()}


async def selection_rows(connection, selection: Selection, limit: int, product_ids: dict[int, int | None]) -> list:
    """The current products of a selection, in display order, at most `limit`. `product_ids` comes from
    current_ids."""
    params: list = []
    where = selection_where(selection, params, product_ids)
    params.append(limit)
    return await connection.fetch(
        f"SELECT p.*, {CATEGORY} AS category_name {FROM} AND {where} "
        f"ORDER BY {DISPLAY_ORDER} LIMIT ${len(params)}",
        *params)


async def member_counts(connection, selection: Selection, product_ids: dict[int, int | None]) -> list[int]:
    """How many current products each included member matches on its own (before exclusions and words),
    so that a member that matches nothing (a misspelt name) can be found and corrected. `product_ids`
    comes from current_ids."""
    params: list = []
    columns = ", ".join(f"count(*) FILTER (WHERE {_member_sql(member, params, product_ids)})"
                        for member in selection.include)
    row = await connection.fetchrow(f"SELECT {columns} {FROM}", *params)
    return [int(value) for value in row.values()]
