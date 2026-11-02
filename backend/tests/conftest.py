"""The journal refuses, in tests, any event or value that is not in its registry."""
import os

os.environ.setdefault("PRICE_CHECKER_V2_LOG_STRICT", "1")

import secrets  # noqa: E402

import pytest  # noqa: E402

from app.api.v2 import credits as _credits  # noqa: E402

# The real keying (an HMAC of the client address), for the tests of the visitor allowance itself.
REAL_VISITOR_KEY = _credits._visitor_key


@pytest.fixture(autouse=True)
def separate_visitor_allowance(monkeypatch):
    """Every test reads prices as its own visitor: the daily allowance is not shared across the suite."""
    key = secrets.token_hex(32)
    monkeypatch.setattr(_credits, "_visitor_key", lambda _request: key)
