"""Credits that pay for seeing prices: product pages, groups, ensembles and baskets.

An account is granted `daily_grant` credits on its first use of each Paris day and holds at most
`hold_max`: what would go beyond is lost. Days without use grant nothing; unused credits carry over
up to the limit. A visitor without an account has `visitor_daily` price views per Paris day, counted
per network address (an HMAC of it, never the address), with nothing carried over. Administrators
are not counted. A contribution an administrator validates earns contribution credits (`bonus`):
no holding limit, no expiry, spent only once the daily credits are used up. The amounts are administrator settings. Every function runs inside the caller's
transaction, so a refused or failed reading spends nothing.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

DEFAULTS = {"daily_grant": 50, "hold_max": 100, "visitor_daily": 10,
            "reward_price": 5, "reward_product": 10, "reward_recipe": 10}
REWARD_KINDS = ("price", "product", "recipe")
_PARIS = ZoneInfo("Europe/Paris")


def paris_now() -> datetime:
    return datetime.now(_PARIS)


async def settings(connection) -> dict:
    """The current amounts, or the defaults on a database that has no settings row yet."""
    row = None
    if await connection.fetchval("SELECT to_regclass('v2_credit_settings') IS NOT NULL"):
        has_rewards = await connection.fetchval(
            "SELECT EXISTS(SELECT 1 FROM information_schema.columns "
            "WHERE table_name='v2_credit_settings' AND column_name='reward_price')")
        columns = "daily_grant,hold_max,visitor_daily,revision" + (",reward_price,reward_product,reward_recipe" if has_rewards else "")
        row = await connection.fetchrow(f"SELECT {columns} FROM v2_credit_settings WHERE singleton")
    return {**DEFAULTS, **dict(row)} if row else {**DEFAULTS, "revision": 0}


def rewards_of(cfg: dict) -> dict:
    """What a validated contribution earns, by kind."""
    return {kind: cfg.get("reward_" + kind, DEFAULTS["reward_" + kind]) for kind in REWARD_KINDS}


def refilled(balance: int, granted_on: date | None, today: date, cfg: dict) -> tuple[int, date]:
    """The balance after today's grant, if it was not made yet. Beyond the holding limit, credits are lost."""
    if granted_on != today:
        balance = max(balance, min(cfg["hold_max"], balance + cfg["daily_grant"]))
        granted_on = today
    return balance, granted_on


def public_state(balance: int, today: date, cfg: dict, bonus: int = 0) -> dict:
    return {
        "balance": balance,
        "bonus": bonus,
        "rewards": rewards_of(cfg),
        "daily_grant": cfg["daily_grant"],
        "hold_max": cfg["hold_max"],
        "next_grant_on": (today + timedelta(days=1)).isoformat(),
        "unlimited": False,
        "visitor": False,
    }


def unlimited_state(today: date, cfg: dict) -> dict:
    """The credits of an administrator, which are not counted."""
    return {**public_state(cfg["hold_max"], today, cfg), "unlimited": True}


def visitor_state(remaining: int, today: date, cfg: dict) -> dict:
    return {
        "balance": remaining,
        "bonus": 0,
        "rewards": rewards_of(cfg),
        "daily_grant": cfg["visitor_daily"],
        "hold_max": cfg["visitor_daily"],
        "next_grant_on": (today + timedelta(days=1)).isoformat(),
        "unlimited": False,
        "visitor": True,
    }


def seconds_until(day: date, now: datetime) -> int:
    midnight = datetime.combine(day, datetime.min.time(), tzinfo=_PARIS)
    return max(1, int((midnight - now).total_seconds()))


async def lock_and_refill(connection, user_id: int, cfg: dict) -> dict:
    """Lock the account's credit row (created on first use) and apply today's grant."""
    now = paris_now()
    await connection.execute(
        "INSERT INTO v2_basket_credits(user_id) VALUES($1) ON CONFLICT DO NOTHING", user_id)
    row = await connection.fetchrow(
        "SELECT balance,granted_on,bonus FROM v2_basket_credits WHERE user_id=$1 FOR UPDATE", user_id)
    balance, granted_on = refilled(row["balance"], row["granted_on"], now.date(), cfg)
    if (balance, granted_on) != (row["balance"], row["granted_on"]):
        await connection.execute(
            "UPDATE v2_basket_credits SET balance=$2,granted_on=$3,updated_at=now() WHERE user_id=$1",
            user_id, balance, granted_on)
    return {"balance": balance, "bonus": row["bonus"], "today": now.date(), "now": now}


async def spend(connection, user_id: int, state: dict, cost: int) -> dict | None:
    """Spend `cost` credits of a locked, refilled account: the daily ones first, then contribution ones.

    None when both together are fewer than `cost` (nothing is spent then).
    """
    row = await connection.fetchrow(
        "UPDATE v2_basket_credits SET balance=balance-least(balance,$2),"
        "bonus=bonus-($2-least(balance,$2)),updated_at=now() "
        "WHERE user_id=$1 AND balance+bonus>=$2 RETURNING balance,bonus", user_id, cost)
    return None if row is None else {**state, "balance": row["balance"], "bonus": row["bonus"]}


async def reward(connection, user_id: int, kind: str, contribution_id: int) -> int:
    """Credit the author of a contribution an administrator just validated, once; the credits granted.

    Inside the validation's transaction. Administrators are not counted, so they earn nothing.
    """
    cfg = await settings(connection)
    credits = cfg.get("reward_" + kind, 0) if kind in REWARD_KINDS else 0
    if credits <= 0 or not await connection.fetchval(
            "SELECT to_regclass('v2_credit_rewards') IS NOT NULL"):
        return 0
    if await connection.fetchval("SELECT role FROM v2_users WHERE id=$1", user_id) in (None, "admin"):
        return 0
    inserted = await connection.fetchval(
        "INSERT INTO v2_credit_rewards(user_id,kind,contribution_id,credits) VALUES($1,$2,$3,$4) "
        "ON CONFLICT (kind,contribution_id) DO NOTHING RETURNING id", user_id, kind, contribution_id, credits)
    if inserted is None:
        return 0
    await connection.execute(
        "INSERT INTO v2_basket_credits(user_id,bonus) VALUES($1,$2) "
        "ON CONFLICT (user_id) DO UPDATE SET bonus=v2_basket_credits.bonus+EXCLUDED.bonus,updated_at=now()",
        user_id, credits)
    return credits


async def visitor_used(connection, key: str, today: date) -> int:
    return await connection.fetchval(
        "SELECT used FROM v2_visitor_credits WHERE key=$1 AND day=$2", key, today) or 0


async def visitor_spend(connection, key: str, cost: int, today: date, allowance: int) -> int | None:
    """Count `cost` views for a visitor today; the remaining views, or None beyond the allowance."""
    await connection.execute("DELETE FROM v2_visitor_credits WHERE day < $1", today - timedelta(days=1))
    if cost > allowance:
        return None
    used = await connection.fetchval(
        """
        INSERT INTO v2_visitor_credits AS v(key, day, used) VALUES($1, $2, $3)
        ON CONFLICT (key) DO UPDATE SET
            used = CASE WHEN v.day = EXCLUDED.day THEN v.used + EXCLUDED.used ELSE EXCLUDED.used END,
            day = EXCLUDED.day
        WHERE (CASE WHEN v.day = EXCLUDED.day THEN v.used ELSE 0 END) + EXCLUDED.used <= $4
        RETURNING used
        """,
        key, today, cost, allowance)
    return None if used is None else allowance - used
