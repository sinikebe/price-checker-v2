#!/usr/bin/env python3
"""Clean what every update leaves on the disk, and report how much room it takes.

Runs as root: from the minute timer (when an administrator asks from the web
interface) and at the end of each successful update. The policy is fixed and
touches nothing but Docker's leftovers: untagged images (the previous version
of each application image) and build cache that no build used for a day.
It never prunes volumes, containers or tagged images, and never deletes the
database or its backups. Nothing from the request file is used as an argument.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import subprocess
import sys
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import state_files  # noqa: E402

CACHE_UNUSED_FOR = "24h"
USAGE_REFRESH = timedelta(hours=6)
PRUNE = {
    "images": ("docker", "image", "prune", "-f"),
    "build_cache": ("docker", "builder", "prune", "-f", "--filter", f"until={CACHE_UNUSED_FOR}"),
}
REQUEST = "cache-clean-request.json"
LAST_RUN = "cache-clean-last-run.json"
USAGE = "server-usage.json"
_UNITS = {"B": 1, "KB": 1000, "MB": 1000**2, "GB": 1000**3, "TB": 1000**4}
_SIZE = re.compile(r"([\d.]+)\s*([kKMGT]?B)\b")
Runner = Callable[[tuple[str, ...]], str]


def run_command(args: tuple[str, ...]) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=900,
                          stdin=subprocess.DEVNULL).stdout


def parse_size(text: str) -> int | None:
    """Bytes in a Docker size such as '1.826GB' or '3.501GB (92%)'."""
    match = _SIZE.search(text or "")
    if match is None:
        return None
    try:
        return round(float(match.group(1)) * _UNITS[match.group(2).upper()])
    except (ValueError, KeyError):
        return None


def reclaimed(output: str) -> int | None:
    """The space a prune reported (image prune: 'Total reclaimed space', builder prune: 'Total')."""
    for line in reversed(output.splitlines()):
        label, _, rest = line.partition(":")
        if label.strip() in ("Total reclaimed space", "Total"):
            return parse_size(rest)
    return None


def measure(run: Runner, data_dir: Path, now: datetime) -> dict:
    rows: dict[str, dict] = {}
    for line in run(("docker", "system", "df", "--format", "{{json .}}")).splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and isinstance(row.get("Type"), str):
            rows[row["Type"]] = row

    def sizes(kind: str) -> tuple[int, int]:
        row = rows.get(kind, {})
        return parse_size(str(row.get("Size", ""))) or 0, parse_size(str(row.get("Reclaimable", ""))) or 0

    image_size, image_reclaimable = sizes("Images")
    cache_size, cache_reclaimable = sizes("Build Cache")
    images = {item for item in run(("docker", "images", "-q", "--no-trunc")).split()}
    dangling = {item for item in run(("docker", "images", "-q", "--no-trunc", "--filter", "dangling=true")).split()}
    count = nbytes = 0
    try:
        with os.scandir(data_dir / "backups") as entries:
            for entry in entries:
                if entry.name.endswith(".dump") and entry.is_file(follow_symlinks=False):
                    count += 1
                    nbytes += entry.stat(follow_symlinks=False).st_size
    except FileNotFoundError:
        pass
    disk = os.statvfs("/")
    used = (disk.f_blocks - disk.f_bfree) * disk.f_frsize
    available = disk.f_bavail * disk.f_frsize
    return {
        "schema": 1, "at": now.isoformat(),
        "disk": {"total_bytes": used + available, "used_bytes": used, "available_bytes": available},
        "images": {"count": len(images), "dangling": len(dangling),
                   "size_bytes": image_size, "reclaimable_bytes": image_reclaimable},
        "build_cache": {"size_bytes": cache_size, "reclaimable_bytes": cache_reclaimable},
        "backups": {"count": count, "bytes": nbytes},
    }


def clean(run: Runner, *, trigger: str, data_dir: Path, state_dir: Path, now: datetime) -> dict:
    freed, known = 0, False
    for command in PRUNE.values():
        size = reclaimed(run(command))
        if size is not None:
            freed, known = freed + size, True
    try:
        state_files.write_json(state_dir / USAGE, measure(run, data_dir, datetime.now(UTC)))
    except (OSError, ValueError, subprocess.SubprocessError):
        pass  # the cleaning itself succeeded; the next refresh updates the figures
    return {"at": datetime.now(UTC).isoformat(), "result": "done", "trigger": trigger,
            "freed_bytes": freed if known else None}


def _failed(trigger: str, exc: Exception) -> dict:
    return {"at": datetime.now(UTC).isoformat(), "result": "failed", "trigger": trigger,
            "message": str(exc)[:200] or exc.__class__.__name__}


def process_request(state_dir: Path, data_dir: Path, run: Runner = run_command,
                    now: datetime | None = None) -> bool:
    """Run the cleaning an administrator asked for. False when there is nothing to do or an update runs."""
    request = state_dir / REQUEST
    try:
        asked = state_files.read_json(request)
    except (ValueError, json.JSONDecodeError):
        asked = {}  # a request is only a signal: a malformed one still counts, and is consumed
    if asked is None:
        return False
    try:
        lock = state_files.open_lock(data_dir / "update.lock")
    except (ValueError, OSError):
        return False
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False  # an update is running: keep the request for the next minute
        state_files.remove_regular(request)
        state_files.write_json(state_dir / LAST_RUN, {
            "at": datetime.now(UTC).isoformat(), "result": "running", "trigger": "manual"})
        try:
            result = clean(run, trigger="manual", data_dir=data_dir, state_dir=state_dir,
                           now=now or datetime.now(UTC))
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            result = _failed("manual", exc)
        state_files.write_json(state_dir / LAST_RUN, result)
        return True
    finally:
        os.close(lock)


def refresh_usage(state_dir: Path, data_dir: Path, run: Runner = run_command,
                  now: datetime | None = None) -> bool:
    """Measure again when the figures are old, so the interface shows today's numbers."""
    now = now or datetime.now(UTC)
    try:
        current = state_files.read_json(state_dir / USAGE)
        at = datetime.fromisoformat(current["at"]) if current else None
    except (ValueError, KeyError, TypeError):
        at = None
    if at is not None and timedelta(0) <= now - at < USAGE_REFRESH:
        return False
    try:
        state_files.write_json(state_dir / USAGE, measure(run, data_dir, now))
    except (OSError, ValueError, subprocess.SubprocessError):
        return False
    return True


def maintenance(state_dir: Path, data_dir: Path) -> None:
    """Called by the minute timer, which holds its own lock; it must never stop an update."""
    process_request(state_dir, data_dir)
    refresh_usage(state_dir, data_dir)


def main() -> int:
    """`clean_server_cache.py DATA_DIR --trigger update`: used by update.sh, which holds the update lock."""
    if len(sys.argv) != 4 or sys.argv[2] != "--trigger" or sys.argv[3] != "update":
        raise SystemExit("Usage: clean_server_cache.py DATA_DIR --trigger update")
    data_dir = Path(sys.argv[1])
    state_dir = data_dir / "state"
    try:
        result = clean(run_command, trigger="update", data_dir=data_dir, state_dir=state_dir,
                       now=datetime.now(UTC))
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(f"Server cache cleaning failed: {exc}", file=sys.stderr)
        return 1
    # An administrator's cleaning may be queued or running: do not overwrite its status.
    try:
        if (state_files.read_json(state_dir / LAST_RUN) or {}).get("result") != "running":
            state_files.write_json(state_dir / LAST_RUN, result)
    except (OSError, ValueError):
        pass
    freed = result["freed_bytes"]
    print("Server cache cleaned" + (f": {freed} bytes freed" if freed is not None else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
