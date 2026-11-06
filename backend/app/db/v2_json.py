"""jsonb values as the routers use them."""

from __future__ import annotations

import json


def decoded(value):
    """A jsonb value as Python data: asyncpg returns jsonb as text; None and decoded values pass through."""
    return json.loads(value) if isinstance(value, str) else value
