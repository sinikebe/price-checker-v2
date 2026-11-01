#!/usr/bin/env python3
"""Minute timer: run one guarded, CI-verified V2 update per local calendar day."""
from __future__ import annotations

import fcntl
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

sys.path.insert(0, str(Path(__file__).resolve().parent))
import clean_server_cache  # noqa: E402
import state_files  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
DATA = Path(os.environ["PRICE_CHECKER_V2_DATA_DIR"])
STATE = DATA / "state"
TIME = re.compile(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]")
VERSION_FILES = {
    "frontend/src/v2/component-versions.json", "frontend/package.json",
    "frontend/package-lock.json", "backend/pyproject.toml",
}


def atomic_json(path: Path, value: dict) -> None:
    # The state directory is writable by the backend container: never follow a link there.
    state_files.write_json(path, value)


@contextmanager
def locked(path: Path):
    descriptor = state_files.open_lock(path)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def schedule_at(now: datetime) -> tuple[dict, datetime] | None:
    schedule = state_files.read_json(STATE / "update-schedule.json")
    if schedule is None:
        return None
    if type(schedule.get("enabled")) is not bool:
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


def ci_succeeded(sha: str, branch: str = "main") -> bool:
    url = ("https://api.github.com/repos/sinikebe/price-checker-v2/"
           f"actions/workflows/ci.yml/runs?event=push&branch={branch}&head_sha={sha}&per_page=10")
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
    environment = os.environ.get("PRICE_CHECKER_V2_ENV")
    if environment not in {"dev", "prod"}:
        raise RuntimeError("Invalid installation environment")
    branch = os.environ.get("PRICE_CHECKER_V2_GIT_BRANCH", "main")
    if branch not in ({"main", "dev"} if environment == "dev" else {"main"}):
        raise RuntimeError("Invalid update branch")
    if not (STATE / "update-scheduler-installed").is_file():
        raise RuntimeError("The scheduler is not installed")
    # This lock serializes timer invocations, including repeated DST minutes.
    with (DATA / "scheduled-update.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            clean_server_cache.maintenance(STATE, DATA)
        except Exception as exc:  # cleaning is optional: it must never stop an update
            print(f"Server cache maintenance failed: {exc}", file=sys.stderr)
        request_path = STATE / "update-manual-request.json"
        active_path = STATE / "update-manual-active.json"
        manual = False
        if active_path.exists() or request_path.exists():
            # The API creates this lock before publishing a request.
            with locked(STATE / "update-manual.lock"):
                if active_path.exists():
                    # A previous worker was interrupted. Do not silently retry an
                    # operation whose completion cannot be established.
                    atomic_json(STATE / "update-last-run.json", {
                        "at": datetime.now().astimezone().isoformat(),
                        "result": "failed", "trigger": "manual",
                        "message": "Previous manual update was interrupted",
                    })
                    active_path.unlink()
                    return 1
                if request_path.exists():
                    os.replace(request_path, active_path)
                    manual = True
                    atomic_json(STATE / "update-last-run.json", {
                        "at": datetime.now().astimezone().isoformat(),
                        "result": "running", "trigger": "manual",
                    })
        if not manual:
            due = schedule_at(datetime.now().astimezone())
            if due is None:
                return 0
            _, local = due
            day = local.date().isoformat()
            day_file = DATA / "scheduled-update-day"
            if day_file.exists() and day_file.read_text(encoding="ascii").strip() == day:
                return 0
            day_file.write_text(day, encoding="ascii")
            os.chmod(day_file, 0o600)
        try:
            old = git("rev-parse", "HEAD")
            git("fetch", "origin", branch)
            target = git("rev-parse", "FETCH_HEAD")
            if subprocess.run(["git", "-C", str(REPO), "merge-base",
                               "--is-ancestor", old, target], check=False).returncode != 0:
                raise RuntimeError("Remote update branch is not a fast-forward")
            if old != target and not ci_succeeded(ci_sha(target), branch):
                raise RuntimeError("CI has not passed for the target commit")
            env = os.environ.copy()
            env["PRICE_CHECKER_V2_EXPECTED_SHA"] = target
            subprocess.run([str(REPO / "deployment/v2/update.sh")], env=env, check=True)
            result = "current" if old == target else "updated"
            outcome = {
                "at": datetime.now().astimezone().isoformat(), "result": result,
                "from": old[:12], "to": target[:12],
                "trigger": "manual" if manual else "scheduled",
            }
            code = 0
        except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError,
                urllib.error.URLError) as exc:
            outcome = {
                "at": datetime.now().astimezone().isoformat(), "result": "failed",
                "message": str(exc)[:200], "trigger": "manual" if manual else "scheduled",
            }
            print(f"Server update failed: {exc}", file=sys.stderr)
            code = 1
        if manual:
            with locked(STATE / "update-manual.lock"):
                atomic_json(STATE / "update-last-run.json", outcome)
                active_path.unlink()
        else:
            atomic_json(STATE / "update-last-run.json", outcome)
        return code


if __name__ == "__main__":
    sys.exit(main())
