"""Validate legal documents supplied by one installation, including backend access."""

import os
from pathlib import Path
import sys

DOCUMENTS = ("mentions", "confidentialite", "conditions")
MAX_DOCUMENT_BYTES = 128 * 1024
BACKEND_UID = 1000


def validate(directory: Path) -> None:
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("Instance legal directory is missing or is a symlink")
    for name in DOCUMENTS:
        path = directory / f"{name}.md"
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Missing instance legal document: {path}")
        if path.stat().st_size > MAX_DOCUMENT_BYTES:
            raise ValueError(f"Oversized instance legal document: {path}")
        if not path.read_bytes().decode("utf-8").strip():
            raise ValueError(f"Empty instance legal document: {path}")


def validate_backend_access(directory: Path) -> None:
    if os.geteuid() != 0:
        raise ValueError("Backend readability check requires root")
    os.chdir(directory.parent)
    os.setgroups([])
    os.setgid(BACKEND_UID)
    os.setuid(BACKEND_UID)
    for name in DOCUMENTS:
        (Path("legal") / f"{name}.md").read_bytes()


if __name__ == "__main__":
    try:
        if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != "--backend-access"):
            raise ValueError("Usage: check-legal-docs.py DIRECTORY [--backend-access]")
        directory = Path(sys.argv[1])
        validate(directory)
        if len(sys.argv) == 3:
            validate_backend_access(directory)
    except (OSError, UnicodeError, ValueError) as exc:
        print(exc, file=sys.stderr)
        sys.exit(1)
