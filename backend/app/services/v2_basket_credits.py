"""Per-account credits that pay for fetching the prices of a basket.

An account is granted DAILY_GRANT credits on its first use of each Paris day,
at most WEEKLY_GRANT_MAX per calendar week (Monday to Sunday), and holds at
most HOLD_MAX. Days without use grant nothing: only the unused credits carry
over. Every function runs inside the caller's transaction.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

DAILY_GRANT = 5
WEEKLY_GRANT_MAX = 20
HOLD_MAX = 20
_PARIS = ZoneInfo("Europe/Paris")


def paris_now() -> datetime:
    return datetime.now(_PARIS)


def _monday(day: date) -> date:
    return day - timedelta(days=day.weekday())


def refilled(balance: int, granted_on: date | None, week_start: date | None,
             week_granted: int, today: date) -> tuple[int, date, date, int]:
    """The credit state after the grant of `today`, if it was not made yet."""
    monday = _monday(today)
    if week_start != monday:
        week_start, week_granted = monday, 0
    if granted_on != today:
        grant = max(0, min(DAILY_GRANT, WEEKLY_GRANT_MAX - week_granted, HOLD_MAX - balance))
        balance += grant
        week_granted += grant
        granted_on = today
    return balance, granted_on, week_start, week_granted


def next_grant_on(today: date, week_granted: int) -> date:
    """The next day on which credits can be granted."""
    tomorrow = today + timedelta(days=1)
    if week_granted >= WEEKLY_GRANT_MAX and tomorrow.weekday() != 0:
        return _monday(today) + timedelta(days=7)
    return tomorrow


def public_state(balance: int, week_granted: int, today: date) -> dict:
    return {
        "balance": balance,
        "daily_grant": DAILY_GRANT,
        "weekly_max": WEEKLY_GRANT_MAX,
        "hold_max": HOLD_MAX,
        "granted_this_week": week_granted,
        "next_grant_on": next_grant_on(today, week_granted).isoformat(),
        "unlimited": False,
    }


def unlimited_state(today: date) -> dict:
    """The credits of an administrator, which are not counted.

    `balance` stays at the holding limit, so that a page loaded before this existed does not disable its button.
    """
    return {**public_state(HOLD_MAX, 0, today), "unlimited": True}


def seconds_until(day: date, now: datetime) -> int:
    midnight = datetime.combine(day, datetime.min.time(), tzinfo=_PARIS)
    return max(1, int((midnight - now).total_seconds()))


async def lock_and_refill(connection, user_id: int) -> dict:
    """Lock the account's credit row (created on first use) and apply today's grant."""
    now = paris_now()
    await connection.execute(
        "INSERT INTO v2_basket_credits(user_id) VALUES($1) ON CONFLICT DO NOTHING", user_id)
    row = await connection.fetchrow(
        "SELECT balance,granted_on,week_start,week_granted FROM v2_basket_credits "
        "WHERE user_id=$1 FOR UPDATE", user_id)
    balance, granted_on, week_start, week_granted = refilled(
        row["balance"], row["granted_on"], row["week_start"], row["week_granted"], now.date())
    if (balance, granted_on, week_start, week_granted) != (
            row["balance"], row["granted_on"], row["week_start"], row["week_granted"]):
        await connection.execute(
            "UPDATE v2_basket_credits SET balance=$2,granted_on=$3,week_start=$4,"
            "week_granted=$5,updated_at=now() WHERE user_id=$1",
            user_id, balance, granted_on, week_start, week_granted)
    return {"balance": balance, "week_granted": week_granted, "today": now.date(), "now": now}


async def spend_one(connection, user_id: int, state: dict) -> dict:
    """Spend one credit of a locked, refilled account."""
    balance = await connection.fetchval(
        "UPDATE v2_basket_credits SET balance=balance-1,updated_at=now() "
        "WHERE user_id=$1 AND balance>=1 RETURNING balance", user_id)
    if balance is None:
        raise ValueError("No credit left")
    return {**state, "balance": balance}
