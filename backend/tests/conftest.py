"""The journal refuses, in tests, any event or value that is not in its registry."""
import os

os.environ.setdefault("PRICE_CHECKER_V2_LOG_STRICT", "1")
