"""Root-side access to files in the application state directory.

The backend container runs as an unprivileged user and can replace anything in
that directory. Code running as root must therefore never follow a link there,
block on a pipe, or change the mode of a file by its name.
"""
from __future__ import annotations

import json
import os
import secrets
import stat
from pathlib import Path

MAX_BYTES = 65536


def _regular(descriptor: int) -> None:
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        raise ValueError("Not a regular file")


def open_lock(path: Path) -> int:
    """A descriptor for a lock file, created if missing; a link or a special file is refused."""
    try:
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o600)
    except OSError as exc:
        raise ValueError(f"Unsafe lock file: {path.name}") from exc
    _regular(descriptor)
    return descriptor


def read_json(path: Path) -> dict | None:
    """The JSON object in a small regular file, or None when the file is missing."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ValueError(f"Unsafe state file: {path.name}") from exc
    _regular(descriptor)
    with os.fdopen(descriptor, "rb") as stream:
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError(f"State file too large: {path.name}")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError(f"Unexpected content: {path.name}")
    return value


def write_json(path: Path, value: dict, mode: int = 0o644) -> None:
    """Replace a state file atomically; a link at its name is replaced, never followed."""
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), mode)
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def remove_regular(path: Path) -> None:
    """Delete a request file, whatever it contains; refuse to touch anything that is not a file."""
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        return
    if not stat.S_ISREG(mode) and not stat.S_ISLNK(mode):
        raise ValueError(f"Not a file: {path.name}")
    path.unlink(missing_ok=True)
