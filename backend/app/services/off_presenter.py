"""Turn an Open Food Facts product document into readable sections.

Recognised keys are displayed in curated sections; all other keys remain in a
catch-all section so the response does not silently omit data.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from app.schemas.off import (
    OffField,
    OffImage,
    OffNutriment,
    OffSection,
)

# ---------------------------------------------------------------------------
# Section definitions
# ---------------------------------------------------------------------------
#
# Ordered as the page reads, most-asked-for first: what the product is, how it
# scores, what is in it, then the long tail of provenance and packaging.
#
# Each entry is (off_key, french_label, kind). The key is claimed whether or not
# the product actually has it -- a product missing ``origins`` simply produces no
# row, but the key is still considered "handled" so an empty value never shows up
# twice (once as a blank row, once in the catch-all).

_IDENTITY: list[tuple[str, str, str]] = [
    ("product_name", "Nom", "text"),
    ("product_name_fr", "Nom (fr)", "text"),
    ("generic_name", "Dénomination générique", "text"),
    ("generic_name_fr", "Dénomination générique (fr)", "text"),
    ("abbreviated_product_name", "Nom abrégé", "text"),
    ("brands", "Marques", "tags"),
    ("quantity", "Quantité", "text"),
    ("product_quantity", "Quantité (valeur)", "number"),
    ("product_quantity_unit", "Quantité (unité)", "text"),
    ("serving_size", "Portion", "text"),
    ("serving_quantity", "Portion (valeur)", "number"),
    ("categories", "Catégories", "tags"),
    ("categories_properties", "Propriétés de catégorie", "json"),
    ("compared_to_category", "Comparé à la catégorie", "text"),
    ("food_groups", "Groupe alimentaire", "tags"),
    ("pnns_groups_1", "Groupe PNNS 1", "text"),
    ("pnns_groups_2", "Groupe PNNS 2", "text"),
    ("product_type", "Type de produit", "text"),
    ("lang", "Langue principale", "text"),
]

_SCORES: list[tuple[str, str, str]] = [
    ("nutriscore_grade", "Nutri-Score", "text"),
    ("nutriscore_score", "Nutri-Score (points)", "number"),
    ("nutriscore_version", "Nutri-Score (barème)", "text"),
    ("nutrition_grades", "Note nutritionnelle", "text"),
    ("nutrition_grade_fr", "Note nutritionnelle (fr)", "text"),
    ("nova_group", "Groupe NOVA", "number"),
    ("nova_groups", "Groupes NOVA (brut)", "text"),
    ("nova_groups_markers", "Marqueurs NOVA", "json"),
    ("ecoscore_grade", "Éco-Score", "text"),
    ("ecoscore_score", "Éco-Score (points)", "number"),
    ("environmental_score_grade", "Score environnemental", "text"),
    ("environmental_score_score", "Score environnemental (points)", "number"),
    ("nutriscore_data", "Détail du calcul Nutri-Score", "json"),
    ("nutriscore", "Nutri-Score par barème", "json"),
    ("ecoscore_data", "Détail du calcul Éco-Score", "json"),
    ("environmental_score_data", "Détail du score environnemental", "json"),
]

_INGREDIENTS: list[tuple[str, str, str]] = [
    ("ingredients_text_fr", "Ingrédients (fr)", "text"),
    ("ingredients_text", "Ingrédients", "text"),
    ("ingredients_text_with_allergens_fr", "Ingrédients avec allergènes (fr)", "text"),
    ("ingredients_text_with_allergens", "Ingrédients avec allergènes", "text"),
    ("ingredients_n", "Nombre d'ingrédients", "number"),
    ("ingredients", "Ingrédients détaillés", "json"),
    ("ingredients_analysis", "Analyse des ingrédients", "json"),
    (
        "ingredients_analysis_tags",
        "Analyse (végane, végétarien, huile de palme)",
        "tags",
    ),
    ("additives_tags", "Additifs", "tags"),
    ("additives_n", "Nombre d'additifs", "number"),
    ("ingredients_percent_analysis", "Analyse des pourcentages", "number"),
    ("ingredients_from_palm_oil_n", "Ingrédients issus d'huile de palme", "number"),
    (
        "ingredients_that_may_be_from_palm_oil_n",
        "Ingrédients possiblement issus d'huile de palme",
        "number",
    ),
    ("ingredients_with_specified_percent_sum", "Somme des % spécifiés", "number"),
    ("ingredients_with_unspecified_percent_sum", "Somme des % non spécifiés", "number"),
]

_ALLERGENS: list[tuple[str, str, str]] = [
    ("allergens", "Allergènes", "tags"),
    ("allergens_tags", "Allergènes (identifiants)", "tags"),
    ("allergens_from_ingredients", "Allergènes déduits des ingrédients", "tags"),
    ("allergens_from_user", "Allergènes saisis", "tags"),
    ("traces", "Traces", "tags"),
    ("traces_tags", "Traces (identifiants)", "tags"),
    ("traces_from_ingredients", "Traces déduites des ingrédients", "tags"),
    ("traces_from_user", "Traces saisies", "tags"),
]

_LABELS: list[tuple[str, str, str]] = [
    ("labels", "Labels", "tags"),
    ("labels_tags", "Labels (identifiants)", "tags"),
]

_ORIGIN: list[tuple[str, str, str]] = [
    ("origins", "Origines", "tags"),
    ("origins_tags", "Origines (identifiants)", "tags"),
    ("manufacturing_places", "Lieux de fabrication", "tags"),
    ("emb_codes", "Codes emballeur", "tags"),
    ("countries", "Pays de vente", "tags"),
    ("purchase_places", "Lieux d'achat", "tags"),
    ("stores", "Magasins", "tags"),
    ("link", "Page du fabricant", "link"),
]

_PACKAGING: list[tuple[str, str, str]] = [
    ("packaging", "Emballage", "tags"),
    ("packagings", "Emballages détaillés", "json"),
    ("packagings_materials", "Matériaux", "json"),
    ("packagings_materials_main", "Matériau principal", "text"),
    ("packagings_complete", "Emballage complet", "number"),
    ("packaging_recycling_tags", "Consignes de tri", "tags"),
]

_PROVENANCE: list[tuple[str, str, str]] = [
    ("code", "Code-barres", "text"),
    ("rev", "Révision OFF", "number"),
    ("created_t", "Créé le", "timestamp"),
    ("last_modified_t", "Modifié le", "timestamp"),
    ("last_updated_t", "Mis à jour le", "timestamp"),
    ("creator", "Créé par", "text"),
    ("last_editor", "Dernier éditeur", "text"),
    ("last_modified_by", "Modifié par", "text"),
    ("data_sources", "Sources des données", "tags"),
    ("owner", "Propriétaire de la fiche", "text"),
    ("completeness", "Complétude", "number"),
    ("complete", "Fiche complète", "number"),
    ("states", "État de la fiche", "tags"),
    ("data_quality_dimensions", "Qualité des données", "json"),
]

# Nutrition's own non-nutriment keys. ``nutriments`` and ``nutrient_levels`` are
# consumed by the table builder itself, not listed here.
_NUTRITION_META: list[tuple[str, str, str]] = [
    ("nutrition_data_per", "Valeurs pour", "text"),
    ("nutrition_data_prepared_per", "Valeurs (préparé) pour", "text"),
    ("nutrition_data", "Données nutritionnelles saisies", "text"),
    ("no_nutrition_data", "Pas de données nutritionnelles", "text"),
    ("nutrition_score_beverage", "Traité comme boisson", "number"),
]

_SECTION_SPECS: list[tuple[str, str, list[tuple[str, str, str]], bool]] = [
    ("identity", "Identité", _IDENTITY, False),
    ("scores", "Scores", _SCORES, False),
    ("ingredients", "Ingrédients & additifs", _INGREDIENTS, False),
    ("allergens", "Allergènes & traces", _ALLERGENS, False),
    ("labels", "Labels", _LABELS, False),
    ("origin", "Origine & distribution", _ORIGIN, False),
    ("packaging", "Emballage", _PACKAGING, True),
    ("provenance", "Source & fraîcheur", _PROVENANCE, True),
]


# ---------------------------------------------------------------------------
# Nutriments
# ---------------------------------------------------------------------------
#
# OFF flattens each nutrient into up to six sibling keys (``salt``,
# ``salt_100g``, ``salt_serving``, ``salt_unit``, ``salt_value``,
# ``salt_modifier``). Regrouping them into one row per nutrient is the single
# biggest readability win available in this payload: 60 flat keys become ~12
# lines of an ordinary nutrition table.
_NUTRIMENT_SUFFIXES = ("_100g", "_serving", "_unit", "_value", "_modifier", "_label")

# Order of the rows a nutrition label conventionally uses. Anything not listed
# follows, alphabetically -- so a nutrient OFF invents next year still appears,
# just below the familiar ones.
_NUTRIMENT_ORDER = [
    "energy-kj",
    "energy-kcal",
    "energy",
    "fat",
    "saturated-fat",
    "trans-fat",
    "cholesterol",
    "carbohydrates",
    "sugars",
    "added-sugars",
    "fiber",
    "proteins",
    "salt",
    "sodium",
    "alcohol",
    "fruits-vegetables-nuts",
    "fruits-vegetables-nuts-estimate",
    "fruits-vegetables-nuts-estimate-from-ingredients",
    "nutrition-score-fr",
]

_NUTRIMENT_LABELS = {
    "energy": "Énergie",
    "energy-kj": "Énergie (kJ)",
    "energy-kcal": "Énergie (kcal)",
    "fat": "Matières grasses",
    "saturated-fat": "dont acides gras saturés",
    "trans-fat": "dont acides gras trans",
    "cholesterol": "Cholestérol",
    "carbohydrates": "Glucides",
    "sugars": "dont sucres",
    "added-sugars": "dont sucres ajoutés",
    "fiber": "Fibres alimentaires",
    "proteins": "Protéines",
    "salt": "Sel",
    "sodium": "Sodium",
    "alcohol": "Alcool",
    "fruits-vegetables-nuts": "Fruits, légumes, noix",
    "fruits-vegetables-nuts-estimate": "Fruits, légumes, noix (estimé)",
    "fruits-vegetables-nuts-estimate-from-ingredients": (
        "Fruits, légumes, noix (estimé d'après les ingrédients)"
    ),
    # OFF puts these two inside ``nutriments`` even though neither is a
    # nutrient -- they are inputs to the Nutri-Score and NOVA calculations that
    # happen to be stored alongside. Labelled rather than left as raw keys
    # because they do appear on real products, and an unlabelled row reads as
    # a rendering bug even when it is faithfully showing what OFF sent.
    "fruits-vegetables-legumes-estimate-from-ingredients": (
        "Fruits, légumes, légumineuses (estimé d'après les ingrédients)"
    ),
    "nova-group": "Groupe NOVA",
    "nutrition-score-fr": "Score nutritionnel (FR)",
    "carbon-footprint-from-known-ingredients_product": "Empreinte carbone (produit)",
}


def _nutriment_label(base: str) -> str:
    """A human label for a nutriment key, falling back to the key itself.

    The fallback is deliberate and is the same principle as the catch-all
    section: an unknown nutrient shows up under its raw OFF name rather than
    being hidden for the crime of not being in a dictionary.
    """
    if base.endswith("_prepared"):
        stem = base[: -len("_prepared")]
        return f"{_NUTRIMENT_LABELS.get(stem, stem)} (préparé)"
    return _NUTRIMENT_LABELS.get(base, base)


def _split_nutriment_key(key: str) -> tuple[str, str | None]:
    """Split ``salt_100g`` into ``("salt", "_100g")``.

    A key with no recognised suffix is its own base with no suffix, which is
    what keeps this total: every possible key maps to some row rather than
    being discarded for having an unexpected shape.
    """
    for suffix in _NUTRIMENT_SUFFIXES:
        if key.endswith(suffix) and len(key) > len(suffix):
            return key[: -len(suffix)], suffix
    return key, None


def _as_number(value: Any) -> float | None:
    """Coerce OFF's loosely-typed numerics, or None.

    OFF serves numbers as ints, floats and strings interchangeably in the same
    field across products. ``bool`` is rejected explicitly because it is an int
    subclass in Python and ``True`` would otherwise silently become 1.0.
    """
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip().replace(",", "."))
        except ValueError:
            return None
    return None


def build_nutriments(
    nutriments: dict[str, Any], levels: dict[str, Any]
) -> list[OffNutriment]:
    """Regroup OFF's flat nutriment keys into table rows.

    Total over its input by construction: every key contributes to some row (see
    ``_split_nutriment_key``), so no nutrient can be dropped by not matching an
    expected pattern.
    """
    grouped: dict[str, dict[str, Any]] = {}
    for key, value in nutriments.items():
        base, suffix = _split_nutriment_key(key)
        grouped.setdefault(base, {})[suffix or ""] = value

    rows: list[OffNutriment] = []
    for base, parts in grouped.items():
        # Prefer the explicit ``_100g`` reading, then the bare key -- for most
        # products OFF sets both to the same number, but where they differ the
        # suffixed one is the one that states its basis.
        per_100g = _as_number(parts.get("_100g"))
        if per_100g is None:
            per_100g = _as_number(parts.get(""))
        unit = parts.get("_unit")
        modifier = parts.get("_modifier")
        rows.append(
            OffNutriment(
                key=base,
                label=_nutriment_label(base),
                per_100g=per_100g,
                per_serving=_as_number(parts.get("_serving")),
                unit=unit if isinstance(unit, str) and unit else None,
                modifier=modifier if isinstance(modifier, str) and modifier else None,
                level=(levels.get(base) if isinstance(levels.get(base), str) else None),
            )
        )

    order = {name: i for i, name in enumerate(_NUTRIMENT_ORDER)}
    rows.sort(key=lambda r: (order.get(r.key, len(order)), r.label.lower()))
    return rows


# ---------------------------------------------------------------------------
# Field rendering
# ---------------------------------------------------------------------------


def _split_csv(value: Any) -> list[str]:
    """OFF's comma-joined strings and its list fields, both to a chip list.

    OFF is inconsistent about which it uses -- ``labels`` is "Bio, AB" while
    ``labels_tags`` is ``["en:organic", "fr:ab"]`` -- and the reader does not
    care. Empty segments are dropped so a trailing comma does not render a
    ghost chip.
    """
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    return []


def _is_empty(value: Any) -> bool:
    """Whether a value is worth a row.

    OFF uses the empty string, the empty list and the empty dict
    interchangeably for "not known", and it also stores literal ``"(fr) "`` in
    user-entered fields that were saved blank -- a real value carrying no
    information. Rendering those as rows would pad the page with dozens of
    labelled blanks and bury the fields that do say something.

    Zero and ``False`` are NOT empty: ``additives_n = 0`` is a meaningful,
    reassuring answer, and dropping it would be the display lying by omission.
    """
    if value is None:
        return True
    if isinstance(value, str):
        stripped = value.strip()
        return not stripped or _is_lang_prefix_only(stripped)
    if isinstance(value, list | dict):
        return len(value) == 0
    return False


def _is_lang_prefix_only(stripped: str) -> bool:
    """``"(fr) "`` -- a language marker with nothing after it.

    Two conditions, and the second one matters more than it looks. The
    parenthesised part must be all there is, AND it must be a two-letter code.
    Without the length check, "(Bio)" -- a perfectly good one-word answer -- is
    indistinguishable from a blank marker and gets silently deleted.

    Two letters rather than "two or three" is a deliberate bias. OFF writes
    these as ISO 639-1 ("fr", "en"), so two is what actually occurs; widening it
    would start swallowing real three-letter values like "(bio)". The failure
    modes are not symmetrical -- showing a spurious "(fr)" row is untidy, hiding
    a real value is the display lying -- so this errs toward showing.
    """
    if not stripped.startswith("("):
        return False
    close = stripped.find(")")
    if close == -1 or stripped[close + 1 :].strip():
        return False
    inner = stripped[1:close].strip()
    return len(inner) == 2 and inner.isalpha()


def _make_field(key: str, label: str, kind: str, value: Any) -> OffField | None:
    """One field, or None when there is nothing to show."""
    if _is_empty(value):
        return None

    if kind == "tags":
        tags = _split_csv(value)
        return OffField(key=key, label=label, kind="tags", tags=tags) if tags else None

    if kind == "number":
        number = _as_number(value)
        return (
            OffField(key=key, label=label, kind="number", number=number)
            if number is not None
            else None
        )

    if kind == "timestamp":
        seconds = _as_number(value)
        if seconds is None:
            return None
        return OffField(
            key=key,
            label=label,
            kind="timestamp",
            timestamp=datetime.fromtimestamp(seconds, tz=UTC),
        )

    if kind == "link":
        url = str(value).strip()
        # Only http(s) reaches the client as a clickable link. OFF's ``link`` is
        # free text typed by contributors, so it can hold anything at all, and
        # an anchor is the one field kind where accepting arbitrary input has
        # consequences beyond looking untidy (javascript: URLs). Anything else
        # degrades to plain text rather than being dropped.
        if url.lower().startswith(("http://", "https://")):
            return OffField(key=key, label=label, kind="link", url=url)
        return OffField(key=key, label=label, kind="text", text=url)

    if kind == "json":
        return OffField(key=key, label=label, kind="json", json_value=value)

    return OffField(key=key, label=label, kind="text", text=str(value).strip())


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------

_IMAGE_SPECS = [
    ("image_front_url", "image_front_thumb_url", "Face avant"),
    ("image_ingredients_url", "image_ingredients_thumb_url", "Ingrédients"),
    ("image_nutrition_url", "image_nutrition_thumb_url", "Tableau nutritionnel"),
    ("image_packaging_url", "image_packaging_thumb_url", "Emballage"),
]

# Every image-ish key OFF emits, claimed by the images section whether or not it
# is rendered as a picture. The small/thumb variants and the big ``images`` /
# ``selected_images`` dictionaries are real data, but showing eight URLs of the
# same photo helps nobody -- they are claimed here and surface in the catch-all's
# structured view instead of cluttering the gallery.
_IMAGE_KEY_PREFIXES = (
    "image_",
    "images",
    "selected_images",
    "last_image_",
    "max_imgid",
)


def build_images(payload: dict[str, Any]) -> list[OffImage]:
    images: list[OffImage] = []
    for url_key, thumb_key, label in _IMAGE_SPECS:
        url = payload.get(url_key)
        if not isinstance(url, str) or not url.strip():
            continue
        thumb = payload.get(thumb_key)
        images.append(
            OffImage(
                key=url_key,
                label=label,
                url=url.strip(),
                thumb_url=thumb.strip() if isinstance(thumb, str) and thumb else None,
            )
        )
    return images


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OffPresentation:
    """The sectioned payload, plus the bookkeeping that proves it is complete.

    ``claimed`` and ``leftover`` are not debug output -- they are the feature's
    correctness argument, exposed so a test can assert it rather than a reader
    having to trust it. Their union is the payload's key set exactly, and they
    do not overlap.

    ``claimed`` is deliberately *not* the same as "keys that produced a visible
    row". A key whose value is empty (OFF pads records with ``""``, ``[]`` and
    ``"(fr) "``) is claimed but renders nothing, because a page of labelled
    blanks buries the fields that do say something. The distinction is why the
    invariant is stated over claimed keys and separately checked to only ever
    hide *empty* ones.
    """

    sections: list[OffSection]
    claimed: set[str]
    leftover: set[str]

    @property
    def presented_count(self) -> int:
        return len(self.claimed)


def build_sections(payload: dict[str, Any]) -> OffPresentation:
    """Section a raw OFF product document.

    Every top-level key ends up either claimed by a curated section or in the
    final catch-all, with no key in both and none in neither. That identity is
    the feature's central promise: all fields are represented.
    """
    consumed: set[str] = set()
    sections: list[OffSection] = []

    def take(keys: list[str]) -> None:
        consumed.update(keys)

    # --- curated label/value sections -------------------------------------
    for section_id, title, specs, collapsed in _SECTION_SPECS:
        fields: list[OffField] = []
        for key, label, kind in specs:
            take([key])
            if key in payload:
                field = _make_field(key, label, kind, payload[key])
                if field is not None:
                    fields.append(field)
        if fields:
            sections.append(
                OffSection(
                    id=section_id,
                    title=title,
                    kind="fields",
                    fields=fields,
                    collapsed=collapsed,
                )
            )

    # --- nutrition table ---------------------------------------------------
    take(["nutriments", "nutrient_levels"])
    raw_nutriments = payload.get("nutriments")
    raw_levels = payload.get("nutrient_levels")
    nutriment_rows = (
        build_nutriments(
            raw_nutriments if isinstance(raw_nutriments, dict) else {},
            raw_levels if isinstance(raw_levels, dict) else {},
        )
        if isinstance(raw_nutriments, dict) and raw_nutriments
        else []
    )
    meta_fields: list[OffField] = []
    for key, label, kind in _NUTRITION_META:
        take([key])
        if key in payload:
            field = _make_field(key, label, kind, payload[key])
            if field is not None:
                meta_fields.append(field)
    if nutriment_rows or meta_fields:
        # Inserted after Scores rather than appended: the nutrition table is the
        # densest genuinely-useful block in the payload, and it belongs next to
        # the grades it explains.
        sections.insert(
            min(2, len(sections)),
            OffSection(
                id="nutrition",
                title="Nutrition",
                kind="nutriments",
                nutriments=nutriment_rows,
                fields=meta_fields,
            ),
        )

    # --- images ------------------------------------------------------------
    image_keys = [k for k in payload if k.startswith(_IMAGE_KEY_PREFIXES)]
    take(image_keys)
    gallery = build_images(payload)
    if gallery:
        sections.append(
            OffSection(id="images", title="Photos", kind="images", images=gallery)
        )

    # --- everything else ---------------------------------------------------
    #
    # The load-bearing part. Anything no section above claimed lands here rather
    # than disappearing, which is what lets the page honestly say it shows the
    # whole record even as OFF adds fields nobody here has heard of.
    remaining = {k: v for k, v in payload.items() if k not in consumed}
    if remaining:
        sections.append(
            OffSection(
                id="raw",
                title=f"Tout le reste ({len(remaining)} champs)",
                kind="raw",
                raw=dict(sorted(remaining.items())),
                collapsed=True,
            )
        )

    # Intersected with the payload: the spec tables claim keys unconditionally
    # (so a key is handled whether or not this particular product has it), but
    # coverage is only meaningful over keys that are actually present.
    return OffPresentation(
        sections=sections,
        claimed=consumed & set(payload),
        leftover=set(remaining),
    )
