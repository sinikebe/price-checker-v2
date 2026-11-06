"""Paris time: the day a price, a product or a recipe is dated with, and the noon that stands for it.

The application dates its content by the Paris calendar day. A reading stored for a day is stored
at noon in Paris, so that the time of day is discarded and the date reads the same everywhere.
"""

from __future__ import annotations

from datetime import date, datetime, time
from zoneinfo import ZoneInfo

PARIS = ZoneInfo("Europe/Paris")


def paris_day(moment: datetime) -> str:
    """The Paris calendar day of an aware moment, as YYYY-MM-DD."""
    return moment.astimezone(PARIS).date().isoformat()


def paris_noon(day: date) -> datetime:
    """Noon in Paris on that day: the moment a price read that day is stored at."""
    return datetime.combine(day, time(12), tzinfo=PARIS)
