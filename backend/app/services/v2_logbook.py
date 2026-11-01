"""Operational journal: events from a fixed registry, made of numbers and values from fixed lists.

Nothing here can record personal information, by construction: an event is
declared in EVENTS with its fields, and each field accepts only an integer in a
range, a boolean, a value from a fixed list, or a string matching a strict
pattern (a version, a short commit, an identifier). There is no free text, and
no field for a name, an address, an account or a request. An event or value
that does not match is dropped (and refused in tests), never stored.

Connector code may use `log_event` too (it runs inside the backend process).
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)

LEVELS = {"debug": 10, "info": 20, "warning": 30, "error": 40}
SOURCES = ("system", "connector", "basket")
RETENTION_DAYS = 30
MAX_ROWS = 200_000

Check = Callable[[Any], Any]


class LogError(ValueError):
    """The event or one of its values is not allowed in the journal."""


def integer(low: int = 0, high: int = 2_147_483_647) -> Check:
    def check(value):
        if type(value) is not int or not low <= value <= high:
            raise LogError(f"integer expected between {low} and {high}")
        return value
    return check


def boolean() -> Check:
    def check(value):
        if type(value) is not bool:
            raise LogError("boolean expected")
        return value
    return check


def choice(*values: str) -> Check:
    def check(value):
        if value not in values:
            raise LogError(f"one of {values} expected")
        return value
    return check


def pattern(expression: str) -> Check:
    compiled = re.compile(expression)

    def check(value):
        if not isinstance(value, str) or compiled.fullmatch(value) is None:
            raise LogError(f"value does not match {expression}")
        return value
    return check


def instant() -> Check:
    def check(value):
        try:
            moment = datetime.fromisoformat(value)
        except (TypeError, ValueError) as exc:
            raise LogError("ISO date expected") from exc
        if moment.tzinfo is None:
            raise LogError("time zone required")
        return moment.isoformat()
    return check


CONNECTOR_ID = r"[a-z][a-z0-9_-]{1,63}"
PRODUCT = integer(1, 2**62)
STORE = integer(1, 2**62)
COUNT = integer()
ORIGIN = choice("basket", "single", "page")
SHA = pattern(r"[0-9a-f]{7,40}")


@dataclass(frozen=True)
class Event:
    source: str
    level: str | Callable[[dict], str]
    fields: dict[str, Check] = field(default_factory=dict)
    optional: frozenset[str] = frozenset()
    connector: bool = False  # needs the id of a connector

    def level_for(self, values: dict) -> str:
        return self.level(values) if callable(self.level) else self.level


EVENTS: dict[str, Event] = {
    "system.started": Event("system", "info", {"version": pattern(r"\d{1,4}\.\d{1,4}\.\d{1,4}")}),
    "system.migrated": Event("system", "info", {
        "count": integer(1, 1000), "latest": pattern(r"\d{4}_[a-z0-9_]{1,60}")}),
    "update.finished": Event(
        "system", lambda values: {"updated": "info", "current": "debug", "failed": "error"}[values["result"]],
        {"trigger": choice("manual", "scheduled"), "result": choice("updated", "current", "failed"),
         "from_sha": SHA, "to_sha": SHA, "run_at": instant(),
         "reason": choice("ci_not_passed", "not_fast_forward", "interrupted", "update_failed", "other")},
        frozenset({"from_sha", "to_sha", "reason"})),
    "cache.cleaned": Event(
        "system", lambda values: "info" if values["result"] == "done" else "warning",
        {"trigger": choice("manual", "update"), "result": choice("done", "failed"),
         "freed_bytes": integer(0, 2**50), "run_at": instant()},
        frozenset({"freed_bytes"})),
    "host.alert": Event("system", "warning", {
        "metric": choice("cpu", "memory", "disk"), "pct": integer(0, 100), "run_at": instant()}),
    "connector.queue.requested": Event(
        "connector", lambda values: "info" if values["queued"] else "debug",
        {"origin": ORIGIN, "requested": COUNT, "queued": COUNT, "fresh": COUNT, "cooldown": COUNT,
         "rate_limited": COUNT, "other": COUNT}, connector=True),
    "connector.queue.added": Event("connector", "info", {"product_id": PRODUCT, "origin": ORIGIN}, connector=True),
    "connector.queue.dropped": Event("connector", "info", {
        "product_id": PRODUCT, "reason": choice("fresh_elsewhere", "cooldown", "unavailable")}, connector=True),
    "connector.reading.finished": Event(
        "connector", lambda values: {"complete": "info", "skipped": "info", "rejected": "warning",
                                     "failed": "error"}[values["outcome"]],
        {"product_id": PRODUCT, "outcome": choice("complete", "skipped", "rejected", "failed")}, connector=True),
    "connector.price.saved": Event("connector", "info", {
        "product_id": PRODUCT, "store_id": STORE, "price_cents": integer(0, 10**9),
        "channel": choice("in_store", "drive", "delivery")}, connector=True),
    "connector.worker.failed": Event("connector", "error", {"error": pattern(r"[A-Za-z][A-Za-z0-9_]{0,59}")}, connector=True),
    "basket.prices.fetched": Event("basket", "info", {
        "items": integer(0, 1000), "products": integer(0, 100_000), "truncated": boolean(),
        "credits_left": integer(0, 1000), "unlimited": boolean()}, frozenset({"credits_left", "unlimited"})),
    "basket.prices.refused": Event("basket", "info", {"reason": choice("no_credits")}),
}

_ENQUEUE_OUTCOMES = {"queued", "fresh", "cooldown", "rate_limited"}
_throttle: dict[str, float] = {}


def strict() -> bool:
    return bool(os.environ.get("PRICE_CHECKER_V2_LOG_STRICT"))


def validate(event: str, fields: dict, connector: str | None = None) -> tuple[Event, dict, str | None]:
    """The event definition, its normalised values and its connector; LogError when anything is not allowed."""
    definition = EVENTS.get(event)
    if definition is None:
        raise LogError(f"unknown event {event!r}")
    unknown = set(fields) - set(definition.fields)
    if unknown:
        raise LogError(f"{event}: fields not allowed: {sorted(unknown)}")
    missing = set(definition.fields) - definition.optional - set(fields)
    if missing:
        raise LogError(f"{event}: missing fields: {sorted(missing)}")
    clean = {}
    for name, value in fields.items():
        if value is None and name in definition.optional:
            continue
        try:
            clean[name] = definition.fields[name](value)
        except LogError as exc:
            raise LogError(f"{event}.{name}: {exc}") from exc
    if definition.connector:
        if connector is None:
            raise LogError(f"{event}: a connector is required")
        pattern(CONNECTOR_ID)(connector)
    elif connector is not None:
        raise LogError(f"{event}: no connector expected")
    return definition, clean, connector


async def log_event(connection, event: str, *, connector: str | None = None,
                    at: datetime | None = None, **fields) -> bool:
    """Record one event. Never raises in production: a journal problem must not break a request."""
    try:
        definition, clean, connector = validate(event, fields, connector)
        level = LEVELS[definition.level_for(clean)]
        # A savepoint, so that a failed insert cannot abort the caller's transaction.
        async with connection.transaction():
            await connection.execute(
                "INSERT INTO v2_logs(at, level, source, event, connector, data) "
                "VALUES(coalesce($1, now()), $2, $3, $4, $5, $6::jsonb)",
                at, level, definition.source, event, connector, json.dumps(clean))
        return True
    except Exception as exc:
        if strict():
            raise
        logger.warning("Journal event %s dropped: %s", event, exc.__class__.__name__)
        return False


def outcome_counts(outcomes: list[str]) -> dict[str, int]:
    """Counts of a connector's `enqueue` results, for connector.queue.requested."""
    counts = {"queued": 0, "fresh": 0, "cooldown": 0, "rate_limited": 0, "other": 0}
    for outcome in outcomes:
        counts[outcome if outcome in _ENQUEUE_OUTCOMES else "other"] += 1
    return counts


def allow_every(key: str, seconds: float) -> bool:
    """True at most once per `seconds` for a key, to keep a repeating failure from flooding the journal."""
    now = time.monotonic()
    if now - _throttle.get(key, -seconds) < seconds:
        return False
    _throttle[key] = now
    return True
