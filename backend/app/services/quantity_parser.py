"""Parse product quantities into a magnitude and comparable base unit.

Reject ambiguous text rather than guessing: an incorrect parsed quantity can
produce a misleading unit price. Results use grams, millilitres or counted
items and are rounded to three decimal places.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

# --------------------------------------------------------------------------- #
# Base units and dimensions
# --------------------------------------------------------------------------- #

UNIT_GRAM = "g"
UNIT_MILLILITRE = "ml"
UNIT_PIECE = "piece"

DIMENSION_MASS = "mass"
DIMENSION_VOLUME = "volume"
DIMENSION_COUNT = "count"

# Base units and their dimensions. Unit prices are comparable only within a
# dimension; EUR/kg and EUR/L cannot be ranked against each other.
DIMENSION_BY_BASE_UNIT: dict[str, str] = {
    UNIT_GRAM: DIMENSION_MASS,
    UNIT_MILLILITRE: DIMENSION_VOLUME,
    UNIT_PIECE: DIMENSION_COUNT,
}

# How many base units are in one of the input units. Keyed by the lowercased
# token exactly as written, with no accent folding: every one of these is ASCII
# and case is the only variation that occurs in practice ("1L" and "1l" are the
# same litre). Folding here would be pure risk for no gain.
_MASS_UNITS: dict[str, Decimal] = {
    "mg": Decimal("0.001"),
    "g": Decimal(1),
    "kg": Decimal(1000),
}
_VOLUME_UNITS: dict[str, Decimal] = {
    "ml": Decimal(1),
    "cl": Decimal(10),
    "dl": Decimal(100),
    "l": Decimal(1000),
}

# Count nouns, keyed by their accent-folded, lowercased form so "cônes",
# "cones", "Cônes" and "CONES" all land on the same entry -- the text comes
# from receipts typed by hand and from OpenFoodFacts, and neither is reliable
# about accents. Singular and plural are listed separately rather than derived,
# because French plurals are not a suffix rule ("rouleau" -> "rouleaux") and a
# rule that is wrong for one noun is worse than eight explicit lines.
#
# Cover common count nouns and variants that can appear in product names or
# quantity fields, so unit prices remain available when those units are used.
#
# The value is the canonical French singular used to LABEL a derived unit price
# ("0,49 €/rouleau"). It is presentation only: the noun actually stored on the
# row is whatever the user wrote, verbatim (see ParsedQuantity.count_noun).
_COUNT_NOUNS: dict[str, str] = {
    "piece": "pièce",
    "pieces": "pièce",
    # List abbreviations explicitly instead of using a prefix rule: "p" and
    # "pc" could otherwise also match "paquet".
    "pc": "pièce",
    "pcs": "pièce",
    "unite": "unité",
    "unites": "unité",
    "rouleau": "rouleau",
    "rouleaux": "rouleau",
    "cone": "cône",
    "cones": "cône",
    "tranche": "tranche",
    "tranches": "tranche",
    "paquet": "paquet",
    "paquets": "paquet",
    "lavage": "lavage",
    "lavages": "lavage",
    "dragee": "dragée",
    "dragees": "dragée",
}

# The stored amount is NUMERIC(12, 3): nine integer digits and three decimals.
# A value at or above this bound cannot be written, so it is refused here
# instead -- see the module docstring on why the parser's contract includes
# "storable". Nothing legitimate comes close: the largest real value in the
# expected grocery quantities are far smaller.
_MAX_BASE_AMOUNT = Decimal(10) ** 9
_STORED_PRECISION = Decimal("0.001")

# A number with an optional decimal part, using EITHER separator. Both occur in
# product data -- "1,5kg" (French convention) and "1.5L" (as
# OpenFoodFacts serves it) -- and neither is a thousands separator anywhere in
# this column, so both can be read as a decimal point unconditionally. There is
# deliberately no support for a sign: a negative quantity is not a typo worth
# rescuing, it is a string this parser should refuse.
_NUMBER = r"\d+(?:[.,]\d+)?"

# One magnitude and one unit token, anchored at both ends. ``fullmatch``-style
# anchoring is the single most important line in this module: it is what makes
# "environ 500g" and "1kg + 20% offert" return None instead of 500 g and 1 kg.
# The unit token is "letters only" (``[^\W\d_]``, which keeps accented letters
# such as the "é" in "unité" while excluding digits, punctuation and "_").
_SINGLE_RE = re.compile(
    rf"^\s*(?P<number>{_NUMBER})\s*(?P<unit>[^\W\d_]+)\s*$",
    re.UNICODE,
)

# "4x100g", "6 x 1L", "3×20cl". Both the ASCII "x" and the real multiplication
# sign occur in product data; case-insensitivity covers "4X100G".
_MULTIPACK_RE = re.compile(
    r"^\s*(?P<count>\d+)\s*[x×]\s*(?P<rest>.+?)\s*$",
    re.IGNORECASE | re.UNICODE,
)


@dataclass(frozen=True)
class ParsedQuantity:
    """A quantity expressed in its dimension's base unit.

    Frozen because it is a value derived from a string: two parses of the same
    text must be indistinguishable, and nothing downstream has any business
    adjusting one in place.
    """

    # Always in ``unit``, always > 0, always quantized to three decimals so it
    # round-trips through NUMERIC(12, 3) unchanged.
    amount: Decimal
    # One of ``g`` / ``ml`` / ``piece``.
    unit: str
    # For counts only, and only ever the noun the user actually wrote, with
    # their capitalisation and their accents -- "rouleaux", not "piece". Null
    # for mass and volume, where the base unit already names the thing.
    count_noun: str | None = None

    @property
    def dimension(self) -> str:
        """``mass`` | ``volume`` | ``count`` -- the comparability class.

        Two quantities may only be compared (ranked, divided into a price,
        described as "cheaper per unit") when this matches. Exposed as a
        property rather than a stored field so it cannot be set to something
        inconsistent with ``unit``.
        """
        return DIMENSION_BY_BASE_UNIT[self.unit]


def _fold(text: str) -> str:
    """Lowercase and strip diacritics, for matching count nouns only.

    NFKD splits "ô" into "o" + combining circumflex; dropping the combining
    marks leaves "o". Used exclusively to look a noun *up*; the string handed
    back to the caller is always the original slice of their input.
    """
    decomposed = unicodedata.normalize("NFKD", text.lower())
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def _to_decimal(number: str) -> Decimal:
    """Read a magnitude written with either decimal separator."""
    return Decimal(number.replace(",", "."))


def _finalize(
    amount: Decimal, unit: str, count_noun: str | None
) -> ParsedQuantity | None:
    """Apply the three storability rules, or refuse.

    Kept in one place so every path (single quantity, multipack) is subject to
    the same rules -- a multipack that multiplies out to something unstorable
    has to be refused just as firmly as a single quantity that was written that
    way, and the easiest way for that to stop being true is for the check to
    live at only one of the two call sites.
    """
    if amount >= _MAX_BASE_AMOUNT:
        return None
    # Quantized *before* the zero check, not after: "0.0001 mg" is 0.0000001 g,
    # which is not zero as written but is indistinguishable from zero once
    # stored -- and a stored zero is a division by zero the first time a unit
    # price is derived from it. Refusing it here is the only point at which
    # that is still cheap.
    stored = amount.quantize(_STORED_PRECISION, rounding=ROUND_HALF_UP)
    if stored <= 0:
        return None
    return ParsedQuantity(amount=stored, unit=unit, count_noun=count_noun)


def _parse_single(text: str) -> ParsedQuantity | None:
    """One magnitude and one unit -- "500g", "1,5kg", "100 g", "6 cônes"."""
    match = _SINGLE_RE.match(text)
    if match is None:
        return None

    magnitude = _to_decimal(match.group("number"))
    raw_unit = match.group("unit")
    lowered = raw_unit.lower()

    if lowered in _MASS_UNITS:
        return _finalize(magnitude * _MASS_UNITS[lowered], UNIT_GRAM, None)
    if lowered in _VOLUME_UNITS:
        return _finalize(magnitude * _VOLUME_UNITS[lowered], UNIT_MILLILITRE, None)
    if _fold(raw_unit) in _COUNT_NOUNS:
        # A count of things must be a whole number of things: "1,5 rouleaux" is
        # not a pack anybody sells, it is a string we have misread. Mass and
        # volume have no equivalent restriction ("1,5kg" is ordinary).
        if magnitude != magnitude.to_integral_value():
            return None
        # The noun is stored exactly as written. Normalising it to a canonical
        # spelling here would throw away the only information that
        # distinguishes "12 rouleaux" from "12 pièces" downstream, which is the
        # whole reason counts carry a noun at all.
        return _finalize(magnitude, UNIT_PIECE, raw_unit)

    # A number followed by letters we do not recognise as a unit. This is the
    # branch that must stay a refusal: "2 lots", "500 kcal" and "6 bouteilles"
    # all land here, and every one of them would be a fabricated unit price.
    return None


def parse_quantity(text: str | None) -> ParsedQuantity | None:
    """Parse a ``reference_quantity`` string, or return None.

    Handles exactly two shapes, both anchored end-to-end:

    * a single quantity -- ``"500g"``, ``"1,5kg"``, ``"100 g"``, ``"50cl"``,
      ``"1.5L"``, ``"12 rouleaux"``;
    * a multipack -- ``"4x100g"`` (400 g), ``"6x1L"`` (6000 ml), ``"3×20cl"``
      (600 ml) -- which is multiplied out, because the shopper buys, and pays
      for, the total.

    Anything else is ``None``. See the module docstring for why that asymmetry
    is deliberate rather than lazy.
    """
    if text is None:
        return None
    # Collapse every run of whitespace (including the non-breaking spaces that
    # arrive with copy-pasted product data) to a single ordinary space, so
    # "100 g", "100  g" and "100 g" are one input, not three.
    normalized = " ".join(text.split())
    if not normalized:
        return None

    multipack = _MULTIPACK_RE.match(normalized)
    if multipack is not None:
        count = Decimal(multipack.group("count"))
        if count <= 0:
            return None
        # The remainder is parsed as a SINGLE quantity, never recursively as
        # another multipack. "2x3x100g" is refused rather than read as 600 g:
        # nested pack notation is rare enough that no convention is settled
        # (is it 2 boxes of 3, or a 2-pack of 3-packs?), and inventing one here
        # would be a guess of exactly the kind this module exists not to make.
        inner = _parse_single(multipack.group("rest"))
        if inner is None:
            return None
        return _finalize(inner.amount * count, inner.unit, inner.count_noun)

    return _parse_single(normalized)


# --------------------------------------------------------------------------- #
# Read-time derivation
# --------------------------------------------------------------------------- #
#
# A derived unit price depends on both quantity and price. Compute it when
# needed so a later correction cannot leave a stale stored result.

# What one unit price is quoted *per*, per dimension, and the label that goes
# with it. Mass is quoted per kilogram and volume per litre because that is what
# French shelf-edge labels use, so the number this app shows can be compared
# against the one printed in the shop without arithmetic. Counts are quoted per
# single item, labelled with the real noun.
_PRESENTATION: dict[str, tuple[Decimal, str]] = {
    UNIT_GRAM: (Decimal(1000), "kg"),
    UNIT_MILLILITRE: (Decimal(1000), "L"),
    UNIT_PIECE: (Decimal(1), "unité"),
}

# Four decimals on the derived figure. Two would be the natural choice for
# money, but this number is also a SORT KEY: at two decimals a 415 g jar and a
# 425 g jar of the same price collapse to the same EUR/kg and their order stops
# being determined by the thing the user was told it was determined by. Four is
# well past any real tie while keeping the JSON free of the ~28 significant
# digits Decimal division produces by default. Rounding for display is the
# client's job, on a number that is already stable.
_DERIVED_PRECISION = Decimal("0.0001")


@dataclass(frozen=True)
class DerivedUnitPrice:
    """A price expressed per kilogram, per litre, or per counted item."""

    amount: Decimal
    # "kg" | "L" | the singular count noun, e.g. "rouleau". Free text as far as
    # consumers are concerned: it exists to be printed after a "/" and must
    # never be parsed back into a dimension -- use ``dimension`` for that.
    unit: str
    # ``mass`` | ``volume`` | ``count``. The field that makes comparability
    # checkable by a consumer without re-deriving anything.
    dimension: str


def count_noun_label(count_noun: str | None) -> str:
    """The singular French noun to print after "€/" for a count.

    Maps the eight nouns this module knows to a canonical singular ("rouleaux"
    -> "rouleau", "pièces" -> "pièce"), because a unit price is per *one* thing
    and "€/rouleaux" reads as a mistake. A noun outside that set is returned
    unchanged rather than guessed at -- French plurals do not follow one rule,
    and inventing a singular is a cosmetic version of exactly the arrogance
    this module avoids everywhere else. A null noun falls back to "unité",
    which is the neutral label for a single unspecified item.
    """
    if not count_noun:
        return _PRESENTATION[UNIT_PIECE][1]
    return _COUNT_NOUNS.get(_fold(count_noun), count_noun)


def derive_unit_price(
    price: Decimal | None,
    *,
    amount: Decimal | None,
    unit: str | None,
    count_noun: str | None = None,
) -> DerivedUnitPrice | None:
    """Price per kilogram / per litre / per item, or None.

    Takes the three stored columns rather than a ``ParsedQuantity`` because
    that is the shape the caller has at read time -- the row came out of the
    database, not out of the parser -- and reconstructing an object just to
    take it apart again would add a place for the two to disagree.

    Returns None whenever the answer would be invented: no price, no parsed
    quantity, a unit this module does not recognise (which would mean the
    column holds something no version of this parser ever wrote), or a
    non-positive quantity. A non-positive *price* is different and is refused
    too: a zero price may represent a free item, but "this
    product costs 0 €/kg" is not a fact about the product, and it would win
    every ascending sort it appeared in.
    """
    if price is None or price <= 0 or amount is None or amount <= 0:
        return None
    presentation = _PRESENTATION.get(unit or "")
    if presentation is None:
        return None
    per, label = presentation
    if unit == UNIT_PIECE:
        label = count_noun_label(count_noun)
    return DerivedUnitPrice(
        amount=(price * per / amount).quantize(
            _DERIVED_PRECISION, rounding=ROUND_HALF_UP
        ),
        unit=label,
        dimension=DIMENSION_BY_BASE_UNIT[unit or ""],
    )
