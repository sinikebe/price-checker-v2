"""Public legal documents supplied by each installation, outside the source tree."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse

from app.api.v2.setup import _state_dir

router = APIRouter(prefix="/api/v2/legal", tags=["v2-legal"])
DOCUMENTS = {"mentions", "confidentialite", "conditions"}
MAX_DOCUMENT_BYTES = 128 * 1024


@router.get("/{document}", response_class=PlainTextResponse)
def legal_document(document: str) -> PlainTextResponse:
    if document not in DOCUMENTS:
        raise HTTPException(status_code=404, detail="Unknown legal document")
    path: Path = _state_dir() / "legal" / f"{document}.md"
    try:
        if not path.is_file() or path.is_symlink() or path.stat().st_size > MAX_DOCUMENT_BYTES:
            raise ValueError("Missing or invalid legal document")
        content = path.read_text(encoding="utf-8")
        if not content.strip():
            raise ValueError("Empty legal document")
    except (OSError, UnicodeError, ValueError) as exc:
        raise HTTPException(status_code=503, detail="Legal document unavailable") from exc
    return PlainTextResponse(content, headers={"Cache-Control": "no-store"})
