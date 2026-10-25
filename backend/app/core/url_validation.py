"""Validate retailer URLs before storing or displaying them as links.

Only HTTP(S) URLs without embedded credentials are accepted. Clickable links
receive additional checks for invisible characters, whitespace and non-ASCII
hostnames. URLs are not fetched, resolved or rewritten here.
"""

from __future__ import annotations

from urllib.parse import urlsplit

# Rejected outright rather than stripped. Stripping silently changes what the
# user is told was recorded; rejecting says so. C0 and C1 ranges plus DEL cover
# NUL, newlines/tabs and ESC; the bidi overrides (U+202A-U+202E, U+2066-U+2069)
# are listed explicitly because Unicode classifies them as printable while they
# reorder rendered text -- the cheapest display-spoofing trick there is.
FORBIDDEN_CHARS = frozenset(
    [chr(c) for c in range(0x20)]
    + [chr(0x7F)]
    + [chr(c) for c in range(0x80, 0xA0)]
    + [chr(c) for c in range(0x202A, 0x202F)]
    + [chr(c) for c in range(0x2066, 0x206A)]
)

# Reject invisible characters in clickable URLs. Code points make this list
# readable without embedding visually hidden characters in the source.
INVISIBLE_CHARS = frozenset(
    chr(c)
    for c in (
        0x200B,  # ZERO WIDTH SPACE
        0x200C,  # ZERO WIDTH NON-JOINER
        0x200D,  # ZERO WIDTH JOINER
        0x2060,  # WORD JOINER
        0xFEFF,  # ZERO WIDTH NO-BREAK SPACE / BOM
    )
)

# Match the product-link field limit; reject rather than truncate long URLs.
MAX_URL_LENGTH = 1000
# Hostnames are capped by DNS itself at 253 octets. Anything longer is not a
# host, so refusing it costs nothing and keeps a pathological netloc out of
# whatever the frontend does with it.
MAX_HOST_LENGTH = 253


def reject_control_chars(value: str, field: str) -> str:
    bad = sorted({c for c in value if c in FORBIDDEN_CHARS})
    if bad:
        codes = ", ".join(f"U+{ord(c):04X}" for c in bad)
        raise ValueError(f"{field} contains forbidden control characters: {codes}")
    return value


def validate_retailer_url(value: str, field: str) -> str:
    """Validate a retailer URL with an HTTP(S) scheme allow-list."""
    reject_control_chars(value, field)
    if len(value) > MAX_URL_LENGTH:
        raise ValueError(f"{field} is longer than {MAX_URL_LENGTH} characters")

    parts = urlsplit(value)
    if parts.scheme.lower() not in ("http", "https"):
        raise ValueError(
            f"{field} must be an http:// or https:// URL (got scheme {parts.scheme!r})"
        )
    if not parts.hostname:
        raise ValueError(f"{field} must include a host")
    if len(parts.hostname) > MAX_HOST_LENGTH:
        raise ValueError(f"{field} host is too long to be a real hostname")
    # ``https://www.carrefour.fr@evil.example/`` is a valid URL whose host is
    # evil.example, but it *reads* as Carrefour to a human glancing at a link.
    # Credentials have no legitimate place in a public product page's URL, so
    # refusing them removes the ambiguity rather than trying to render around
    # it later.
    if parts.username is not None or parts.password is not None:
        raise ValueError(f"{field} must not contain embedded credentials")
    return value


def validate_clickable_url(value: str, field: str) -> str:
    """``validate_retailer_url`` plus the three rules a rendered anchor needs.

    See the module docstring for why each of the three exists. Order matters
    only in what the user is told first: the shared rules run first so that a
    ``javascript:`` URL is reported as a bad scheme rather than as a bad host.
    """
    validate_retailer_url(value, field)

    invisible = sorted({c for c in value if c in INVISIBLE_CHARS})
    if invisible:
        codes = ", ".join(f"U+{ord(c):04X}" for c in invisible)
        raise ValueError(
            f"{field} contains invisible characters that would hide part of "
            f"the link: {codes}"
        )
    # ``split()`` with no argument splits on every kind of Unicode whitespace,
    # including the ones that are not in the C0 range (U+00A0 no-break space,
    # U+2028 line separator), which is exactly the set a naive `' ' in value`
    # check would miss.
    if len(value.split()) > 1:
        raise ValueError(f"{field} must not contain spaces")

    host = urlsplit(value).hostname or ""
    if not host.isascii():
        raise ValueError(
            f"{field} host must be ASCII: a non-ASCII domain can be made to "
            "render identically to a real one in a link"
        )
    return value
