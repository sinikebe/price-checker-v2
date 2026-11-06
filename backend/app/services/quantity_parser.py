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
# Base units
# --------------------------------------------------------------------------- #

UNIT_GRAM = "g"
UNIT_MILLILITRE = "ml"
UNIT_PIECE = "piece"

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
# rule that is wrong for one noun is worse than explicit lines.
#
# Cover common count nouns and variants that can appear in product names or
# quantity fields, so unit prices remain available when those units are used.
_COUNT_NOUNS: frozenset[str] = frozenset({
    "piece", "pieces",
    # List abbreviations explicitly instead of using a prefix rule: "p" and
    # "pc" could otherwise also match "paquet".
    "pc", "pcs",
    "unite", "unites",
    "rouleau", "rouleaux",
    "cone", "cones",
    "tranche", "tranches",
    "paquet", "paquets",
    "lavage", "lavages",
    "dragee", "dragees",
})

# Amounts are kept to three decimals and below 10^9, the same bounds as
# ExtraQuantity in app/api/v2/products.py; anything larger is refused.
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

    # Always in ``unit``, always > 0, always quantized to three decimals.
    amount: Decimal
    # One of ``g`` / ``ml`` / ``piece``.
    unit: str
    # For counts only, and only ever the noun the user actually wrote, with
    # their capitalisation and their accents -- "rouleaux", not "piece". Null
    # for mass and volume, where the base unit already names the thing.
    count_noun: str | None = None


def _fold(text: str) -> str:
    """Lowercase and strip diacritics, for matching count nouns only.

    NFKD splits "ô" into "o" + combining circumflex; dropping the combining
    marks leaves "o". Used exclusively to look a noun *up*; the string handed
    back to the caller is always the original slice of their input.
    """
    decomposed = unicodedata.normalize("NFKD", text.lower())
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def _normalized(text: str | None) -> str:
    """Every run of whitespace collapsed to one ordinary space, the non-breaking
    spaces of copy-pasted product data included: "100 g", "100  g" and
    "100\u00a0g" are one input, not three."""
    return " ".join((text or "").split())


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
    """Parse a product quantity text, or return None.

    Handles exactly two shapes, both anchored end-to-end:

    * a single quantity -- ``"500g"``, ``"1,5kg"``, ``"100 g"``, ``"50cl"``,
      ``"1.5L"``, ``"12 rouleaux"``;
    * a multipack -- ``"4x100g"`` (400 g), ``"6x1L"`` (6000 ml), ``"3×20cl"``
      (600 ml) -- which is multiplied out, because the shopper buys, and pays
      for, the total.

    Anything else is ``None``: it is refused rather than guessed (see the
    module docstring).
    """
    if text is None:
        return None
    normalized = _normalized(text)
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


def parse_measures(text: str | None) -> list[ParsedQuantity]:
    """Every measure a quantity text states, the main one first.

    A pack is sold by weight, by volume or by the piece, and a multipack states
    two of them at once: "4x125g" is 500 g and also four pieces. Both are
    returned so the shopper can compare it per kilogram or per piece. Anything
    else is exactly what :func:`parse_quantity` returns (a list of one, or
    nothing); this never invents a count that the text does not state.
    """
    main = parse_quantity(text)
    if main is None:
        return []
    measures = [main]
    multipack = _MULTIPACK_RE.match(_normalized(text))
    if multipack is not None and main.unit != UNIT_PIECE:
        count = _finalize(Decimal(multipack.group("count")), UNIT_PIECE, None)
        if count is not None:
            measures.append(count)
    return measures
