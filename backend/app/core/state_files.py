"""Small files in the state directory, shared with the host's root-owned timers.

The backend writes its database settings and its requests (an update, a cache cleaning) there,
and the host publishes its results there. A file is written whole or not at all, so a reader
never sees half of one.
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime
from pathlib import Path


def read_json_object(path: Path, max_chars: int) -> dict:
    """The JSON object in a file of at most `max_chars` characters.

    OSError (FileNotFoundError included) when the file cannot be read; ValueError when it is too
    long, is not JSON or does not hold an object.
    """
    with path.open("r", encoding="utf-8") as stream:
        raw = stream.read(max_chars + 1)
    if len(raw) > max_chars:
        raise ValueError(f"{path.name} is too large")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} does not hold a JSON object")
    return value


def aware_datetime(value) -> datetime | None:
    """An ISO 8601 moment that states its time zone, or None for anything else."""
    try:
        moment = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    return moment if moment.tzinfo else None


def write_atomic(path: Path, data: bytes, *, mode: int = 0o600, exclusive: bool = False) -> None:
    """Write a file whole or not at all, through a temporary file beside it.

    The file is readable by its owner only unless `mode` says otherwise. With `exclusive`, an
    existing file is kept and FileExistsError raised; otherwise it is replaced.
    """
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if mode != 0o600:  # mkstemp creates the file with 0600 already
            os.chmod(name, mode)
        if exclusive:
            os.link(name, path)
        else:
            os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def write_json_atomic(path: Path, value, *, mode: int = 0o600, exclusive: bool = False) -> None:
    """Write `value` as JSON, in the bytes json.dump writes, with write_atomic."""
    write_atomic(path, json.dumps(value).encode("utf-8"), mode=mode, exclusive=exclusive)


def scheduler_installed(directory: Path) -> bool:
    """Whether the host's root-owned timer is installed: it leaves this marker in the state directory."""
    return (directory / "update-scheduler-installed").is_file()
