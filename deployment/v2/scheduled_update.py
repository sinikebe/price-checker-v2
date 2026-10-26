#!/usr/bin/env python3
"""Minute timer: run one guarded, CI-verified V2 update per local calendar day."""
from __future__ import annotations

import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

REPO = Path(__file__).resolve().parents[2]
DATA = Path(os.environ["PRICE_CHECKER_V2_DATA_DIR"])
STATE = DATA / "state"
TIME = re.compile(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]")
VERSION_FILES = {
    "frontend/src/v2/component-versions.json", "frontend/package.json",
    "frontend/package-lock.json", "backend/pyproject.toml",
}


def atomic_json(path: Path, value: dict) -> None:
    descriptor, name = tempfile.mkstemp(prefix=".scheduled-update-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            json.dump(value, target)
            target.flush()
            os.fsync(target.fileno())
        os.chmod(name, 0o644)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def schedule_at(now: datetime) -> tuple[dict, datetime] | None:
    try:
        schedule = json.loads((STATE / "update-schedule.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    if not isinstance(schedule, dict) or type(schedule.get("enabled")) is not bool:
        raise ValueError("Invalid update schedule")
    if not schedule["enabled"]:
        return None
    time = schedule.get("time")
    zone_name = schedule.get("timezone")
    if not isinstance(time, str) or not TIME.fullmatch(time) or not isinstance(zone_name, str):
        raise ValueError("Invalid update schedule")
    try:
        local = now.astimezone(ZoneInfo(zone_name))
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("Invalid update timezone") from exc
    return (schedule, local) if local.strftime("%H:%M") == time else None


def git(*args: str) -> str:
    return subprocess.check_output(["git", "-C", str(REPO), *args], text=True).strip()


def ci_sha(target: str) -> str:
    subject = git("show", "-s", "--format=%s", target)
    author = git("show", "-s", "--format=%ae", target)
    if subject != "chore: bump affected component versions [skip ci]":
        return target
    if author != "41898282+github-actions[bot]@users.noreply.github.com":
        raise RuntimeError("Untrusted CI-skip commit")
    changed = set(git("diff-tree", "--no-commit-id", "--name-only", "-r", target).splitlines())
    if not changed or not changed <= VERSION_FILES:
        raise RuntimeError("CI-skip commit has unexpected changes")
    return git("rev-parse", f"{target}^")


def ci_succeeded(sha: str) -> bool:
    url = ("https://api.github.com/repos/sinikebe/price-checker-v2/"
           f"actions/workflows/ci.yml/runs?event=push&branch=main&head_sha={sha}&per_page=10")
    request = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "price-checker-v2-scheduled-update",
    })
    with urllib.request.urlopen(request, timeout=12) as response:
        runs = json.load(response).get("workflow_runs", [])
    return any(run.get("head_sha") == sha and run.get("status") == "completed"
               and run.get("conclusion") == "success" for run in runs)


def main() -> int:
    if os.geteuid() != 0:
        raise RuntimeError("The scheduler must run as root")
    if os.environ.get("PRICE_CHECKER_V2_ENV") not in {"dev", "prod"}:
        raise RuntimeError("Invalid installation environment")
    if not (STATE / "update-scheduler-installed").is_file():
        raise RuntimeError("The scheduler is not installed")
    # This lock also prevents duplicate runs during a repeated DST minute.
    with (DATA / "scheduled-update.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        due = schedule_at(datetime.now().astimezone())
        if due is None:
            return 0
        _, local = due
        day = local.date().isoformat()
        day_file = DATA / "scheduled-update-day"
        if day_file.exists() and day_file.read_text(encoding="ascii").strip() == day:
            return 0
        day_file.write_text(day, encoding="ascii")
        try:
            os.chmod(day_file, 0o600)
            old = git("rev-parse", "HEAD")
            git("fetch", "origin", "main")
            target = git("rev-parse", "FETCH_HEAD")
            if not subprocess.run(["git", "-C", str(REPO), "merge-base",
                                   "--is-ancestor", old, target], check=False).returncode == 0:
                raise RuntimeError("Remote main is not a fast-forward")
            if old != target and not ci_succeeded(ci_sha(target)):
                raise RuntimeError("CI has not passed for the target commit")
            env = os.environ.copy()
            env["PRICE_CHECKER_V2_EXPECTED_SHA"] = target
            subprocess.run([str(REPO / "deployment/v2/update.sh")], env=env, check=True)
            result = "current" if old == target else "updated"
            atomic_json(STATE / "update-last-run.json", {
                "at": datetime.now().astimezone().isoformat(), "result": result,
                "from": old[:12], "to": target[:12],
            })
            return 0
        except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError,
                urllib.error.URLError) as exc:
            atomic_json(STATE / "update-last-run.json", {
                "at": datetime.now().astimezone().isoformat(), "result": "failed",
                "message": str(exc)[:200],
            })
            print(f"Scheduled update failed: {exc}", file=sys.stderr)
            return 1


if __name__ == "__main__":
    sys.exit(main())
