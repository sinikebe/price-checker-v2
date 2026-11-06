"""Public legal documents supplied by each installation, outside the source tree.

The documents live in the installation's state directory (`legal/<name>.md`). Administrators can replace
them from the settings with a Markdown file; the replaced version is kept beside it (`<name>.previous.md`).
"""

from __future__ import annotations

import hashlib
import os
import secrets
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from app.api.v2.auth import _connect, _require_admin_role, _secure_write, _session_user, per_minute_limit
from app.api.v2.auth_security import account_limit_key
from app.api.v2.setup import _state_dir
from app.services import v2_logbook as logbook

router = APIRouter(prefix="/api/v2/legal", tags=["v2-legal"])
DOCUMENTS = {"mentions", "confidentialite", "conditions"}
ORDER = ("mentions", "confidentialite", "conditions")
MAX_DOCUMENT_BYTES = 128 * 1024
UPDATES_PER_MINUTE = 20


def _document_path(document: str) -> Path:
    return _state_dir() / "legal" / f"{document}.md"


@router.get("/{document}", response_class=PlainTextResponse)
def legal_document(document: str) -> PlainTextResponse:
    if document not in DOCUMENTS:
        raise HTTPException(status_code=404, detail="Unknown legal document")
    path = _document_path(document)
    try:
        if not path.is_file() or path.is_symlink() or path.stat().st_size > MAX_DOCUMENT_BYTES:
            raise ValueError("Missing or invalid legal document")
        content = path.read_text(encoding="utf-8")
        if not content.strip():
            raise ValueError("Empty legal document")
    except (OSError, UnicodeError, ValueError) as exc:
        raise HTTPException(status_code=503, detail="Legal document unavailable") from exc
    return PlainTextResponse(content, headers={"Cache-Control": "no-store"})


class LegalUpdate(BaseModel):
    content: str = Field(min_length=1, max_length=MAX_DOCUMENT_BYTES)
    # The version being replaced (sha256 of the current file, null when there is none): a file changed
    # in the meantime is not overwritten.
    expected_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


def _state(document: str) -> dict:
    path = _document_path(document)
    absent = {"name": document, "present": False, "bytes": 0, "modified_at": None, "sha256": None}
    try:
        if path.is_symlink() or not path.is_file():
            return absent
        data = path.read_bytes()
        modified = datetime.fromtimestamp(path.stat().st_mtime, UTC).isoformat(timespec="seconds")
    except OSError:
        return absent
    return {"name": document, "present": bool(data.strip()), "bytes": len(data), "modified_at": modified,
            "sha256": hashlib.sha256(data).hexdigest()}


async def _admin(connection, request: Request) -> dict:
    return _require_admin_role(await _session_user(connection, request))


@router.get("")
async def legal_documents(request: Request, response: Response):
    """Administrators: which documents this installation serves, with their size and date."""
    response.headers["Cache-Control"] = "no-store"
    connection = await _connect()
    try:
        await _admin(connection, request)
    finally:
        await connection.close()
    return {"documents": [_state(name) for name in ORDER], "max_bytes": MAX_DOCUMENT_BYTES}


def _write(document: str, text: str) -> None:
    """Replace the document atomically, keeping the replaced version as `<name>.previous.md`."""
    directory = _state_dir() / "legal"
    if directory.is_symlink():
        raise OSError("legal directory is a symlink")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / f"{document}.md"
    if path.is_symlink():
        raise OSError("legal document is a symlink")
    temporary = directory / f".{document}.{secrets.token_hex(6)}.tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    previous = None
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(text.encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        if path.is_file():
            previous = directory / f".{document}.{secrets.token_hex(6)}.previous"
            copy = os.open(previous, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(copy, "wb") as handle:
                handle.write(path.read_bytes())
            os.replace(previous, directory / f"{document}.previous.md")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
        if previous is not None:
            previous.unlink(missing_ok=True)


@router.put("/{document}")
async def update_legal_document(document: str, payload: LegalUpdate, request: Request, response: Response):
    """Administrators: replace a legal document with this Markdown text (at most 128 KiB in UTF-8)."""
    _secure_write(request)
    response.headers["Cache-Control"] = "no-store"
    if document not in DOCUMENTS:
        raise HTTPException(status_code=404, detail="Document légal inconnu.")
    text = payload.content.replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        raise HTTPException(status_code=422, detail="Le document est vide.")
    size = len(text.encode("utf-8"))
    if size > MAX_DOCUMENT_BYTES:
        raise HTTPException(status_code=422, detail="Le document dépasse 128 Ko.")
    if "\x00" in text:
        raise HTTPException(status_code=422, detail="Le document n’est pas un texte valide.")
    connection = await _connect()
    try:
        user = await _admin(connection, request)
        await per_minute_limit(connection, account_limit_key("legal-update", user["id"]), UPDATES_PER_MINUTE,
                               "Trop de mises à jour. Réessayez dans une minute.")
        if _state(document)["sha256"] != payload.expected_sha256:
            raise HTTPException(status_code=409,
                                detail="Ce document a changé depuis son affichage : rechargez la page, puis recommencez.")
        try:
            _write(document, text)
        except OSError as exc:
            raise HTTPException(status_code=503,
                                detail="Le dossier des documents légaux n’est pas modifiable sur ce serveur.") from exc
        await logbook.log_event(connection, "legal.document.updated", document=document, bytes=size)
    finally:
        await connection.close()
    return _state(document)
