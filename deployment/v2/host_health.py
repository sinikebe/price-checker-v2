#!/usr/bin/env python3
"""Small host-side sampler; one bounded JSON file, no database or long-running process."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import secrets
from datetime import UTC, datetime, timedelta
from pathlib import Path

SCHEMA = 1
METRICS = ("cpu", "memory", "disk")
THRESHOLD = 80.0
COOLDOWN = timedelta(hours=1)
RETENTION = timedelta(hours=24)


def cpu_counters(value: str) -> dict[str, int]:
    fields = value.splitlines()[0].split()
    if fields[0] != "cpu" or len(fields) < 9:
        raise ValueError("Invalid /proc/stat CPU counters")
    numbers = [int(item) for item in fields[1:9]]
    return {"total": sum(numbers), "idle": numbers[3] + numbers[4]}


def memory_usage(value: str) -> dict[str, int | float]:
    fields = {}
    for line in value.splitlines():
        name, _, rest = line.partition(":")
        if name in ("MemTotal", "MemAvailable"):
            fields[name] = int(rest.split()[0]) * 1024
    total, available = fields["MemTotal"], fields["MemAvailable"]
    if total <= 0 or not 0 <= available <= total:
        raise ValueError("Invalid /proc/meminfo values")
    return {"total_bytes": total, "used_bytes": total - available,
            "available_bytes": available, "pct": 100 * (total - available) / total}


def disk_usage(stats: os.statvfs_result) -> dict[str, int | float]:
    block = stats.f_frsize
    used = (stats.f_blocks - stats.f_bfree) * block
    available = stats.f_bavail * block
    usable = used + available
    if usable <= 0:
        raise ValueError("Invalid root filesystem capacity")
    return {"total_bytes": usable, "used_bytes": used,
            "available_bytes": available, "pct": 100 * used / usable}


def updated_state(previous: dict, at: datetime, cpu: dict[str, int],
                  memory: dict, disk: dict) -> dict:
    if previous and previous.get("schema") != SCHEMA:
        raise ValueError("Unsupported host-health state")
    at = at.astimezone(UTC)
    hour = at.replace(minute=0, second=0, microsecond=0).isoformat()
    cutoff = (at - RETENTION).isoformat()
    prior_cpu = previous.get("previous_cpu", {})
    cpu_pct = None
    previous_at = datetime.fromisoformat(previous["updated_at"]) if previous.get("updated_at") else None
    fresh_interval = previous_at is not None and timedelta(0) < at - previous_at <= timedelta(minutes=5)
    if fresh_interval and cpu["total"] > prior_cpu.get("total", cpu["total"]):
        delta_total = cpu["total"] - prior_cpu["total"]
        delta_idle = cpu["idle"] - prior_cpu["idle"]
        if 0 <= delta_idle <= delta_total:
            cpu_pct = max(0.0, min(100.0, 100 * (delta_total - delta_idle) / delta_total))
    hours = {item["hour"]: item for item in previous.get("hourly", []) if item["hour"] >= cutoff[:13] + ":00:00+00:00"}
    point = hours.get(hour, {"hour": hour, "cpu_sum": 0.0, "cpu_count": 0,
                             "cpu_max": None, "memory_sum": 0.0, "samples": 0,
                             "memory_max": 0.0, "disk_pct": 0.0})
    if cpu_pct is not None:
        point["cpu_sum"] += cpu_pct
        point["cpu_count"] += 1
        point["cpu_max"] = max(point["cpu_max"] or 0.0, cpu_pct)
    point["memory_sum"] += memory["pct"]
    point["samples"] += 1
    point["memory_max"] = max(point["memory_max"], memory["pct"])
    point["disk_pct"] = disk["pct"]
    hours[hour] = point
    hourly = [hours[key] for key in sorted(hours)[-24:]]
    cooldowns = previous.get("cooldowns", {}).copy()
    alerts = [item for item in previous.get("alerts", []) if item["at"] >= cutoff]
    values = {"cpu": cpu_pct, "memory": memory["pct"], "disk": disk["pct"]}
    for metric in METRICS:
        value = values[metric]
        if value is None or value <= THRESHOLD:
            continue
        last = cooldowns.get(metric)
        if last and timedelta(0) <= at - datetime.fromisoformat(last) < COOLDOWN:
            continue
        alerts.append({"metric": metric, "at": at.isoformat(), "pct": round(value, 1)})
        cooldowns[metric] = at.isoformat()
    return {"schema": SCHEMA, "updated_at": at.isoformat(),
            "current": {"cpu_pct": round(cpu_pct, 1) if cpu_pct is not None else None,
                        "memory": memory, "disk": disk},
            "hourly": hourly, "alerts": alerts[-72:], "cooldowns": cooldowns,
            "previous_cpu": cpu}


def collect(state_dir: Path, *, at: datetime | None = None,
            proc_stat: str | None = None, proc_meminfo: str | None = None,
            filesystem: os.statvfs_result | None = None) -> dict:
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (state_dir / "host-health.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        target = state_dir / "host-health.json"
        try:
            previous = json.loads(target.read_text(encoding="utf-8"))
        except FileNotFoundError:
            previous = {}
        cpu = cpu_counters(proc_stat if proc_stat is not None else Path("/proc/stat").read_text())
        memory = memory_usage(proc_meminfo if proc_meminfo is not None else Path("/proc/meminfo").read_text())
        disk = disk_usage(filesystem if filesystem is not None else os.statvfs("/"))
        result = updated_state(previous, at or datetime.now(UTC), cpu, memory, disk)
        name = f".host-health-{os.getpid()}-{secrets.token_hex(8)}"
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(result, stream, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, target)
        finally:
            Path(name).unlink(missing_ok=True)
        return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("state_dir", type=Path)
    args = parser.parse_args()
    # The parent data directory is root-only; enter the app-owned state first.
    os.chdir(args.state_dir)
    # A container UID may have no host passwd entry, so systemd cannot use User=1000.
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(1000)
        os.setuid(1000)
    if os.geteuid() != 1000:
        raise PermissionError("Host sampling must run as the V2 state owner (UID 1000)")
    collect(Path("."))


if __name__ == "__main__":
    main()
