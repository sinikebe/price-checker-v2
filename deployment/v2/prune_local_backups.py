#!/usr/bin/env python3
"""Prune old updater backups only when a newly verified dump is available.

This handles local updater artifacts, not off-host backup scheduling or proof
of restoration. The updater invokes it only after the application is healthy.
"""

from __future__ import annotations

import calendar
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

STAMP = re.compile(r"^(?:db-cert-)?(\d{8}T\d{6}Z)-[0-9a-f]{7,40}(?:\.dump)?$")
DUMP = re.compile(r"^\d{8}T\d{6}Z-[0-9a-f]{7,40}\.dump$")


def six_months_before(moment: datetime) -> datetime:
    month = moment.month - 6
    year = moment.year
    if month <= 0:
        month += 12
        year -= 1
    day = min(moment.day, calendar.monthrange(year, month)[1])
    return moment.replace(year=year, month=month, day=day)


def prune(directory: Path, verified_dump: Path, *, now: datetime | None = None) -> list[str]:
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError("Invalid backup directory")
    if verified_dump.parent != directory or not DUMP.fullmatch(verified_dump.name):
        raise ValueError("Verified dump must be an updater dump in this directory")
    if not verified_dump.is_file() or verified_dump.is_symlink() or verified_dump.stat().st_size == 0:
        raise ValueError("Recent verified dump is unavailable")
    now = now or datetime.now(timezone.utc)
    cutoff = six_months_before(now)
    verified_date = datetime.strptime(verified_dump.name[:16], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    if not cutoff < verified_date <= now:
        raise ValueError("Verified dump is not recent")
    removed: list[str] = []
    for entry in directory.iterdir():
        match = STAMP.fullmatch(entry.name)
        if entry == verified_dump or match is None or entry.is_symlink():
            continue
        try:
            stamp = datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if stamp >= cutoff:
            continue
        if DUMP.fullmatch(entry.name) and entry.is_file():
            entry.unlink()
            removed.append(entry.name)
        elif entry.name.startswith("db-cert-") and entry.is_dir():
            # Only the exact updater certificate pair may be removed.
            children = list(entry.iterdir())
            if {item.name for item in children} == {"server.key", "server.crt"} and all(
                item.is_file() and not item.is_symlink() for item in children
            ):
                for item in children:
                    item.unlink()
                entry.rmdir()
                removed.append(entry.name)
    return removed


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: prune_local_backups.py BACKUP_DIR VERIFIED_DUMP")
    for name in prune(Path(sys.argv[1]), Path(sys.argv[2])):
        print(f"Expired local backup removed: {name}")
