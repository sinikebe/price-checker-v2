"""Validate the three public documents supplied by one installation."""

from pathlib import Path
import sys

DOCUMENTS = ("mentions", "confidentialite", "conditions")
MAX_DOCUMENT_BYTES = 128 * 1024


def validate(directory: Path) -> None:
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("Instance legal directory is missing or is a symlink")
    for name in DOCUMENTS:
        path = directory / f"{name}.md"
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Missing instance legal document: {path}")
        content = path.read_bytes()
        if len(content) > MAX_DOCUMENT_BYTES or not content.decode("utf-8").strip():
            raise ValueError(f"Invalid instance legal document: {path}")


if __name__ == "__main__":
    try:
        validate(Path(sys.argv[1]))
    except (IndexError, OSError, UnicodeError, ValueError) as exc:
        print(exc, file=sys.stderr)
        sys.exit(1)
