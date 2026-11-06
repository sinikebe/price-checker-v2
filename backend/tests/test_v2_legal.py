"""Legal pages are installation state, never a source-code fallback."""

import httpx
import pytest

from app.api.v2 import auth, legal
from app.main_v2 import app


@pytest.mark.asyncio
async def test_legal_document_requires_instance_file(tmp_path, monkeypatch):
    monkeypatch.setattr(legal, "_state_dir", lambda: tmp_path)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
        assert (await client.get("/api/v2/legal/mentions")).status_code == 503
        assert (await client.get("/api/v2/legal/unknown")).status_code == 404
        directory = tmp_path / "legal"
        directory.mkdir()
        document = directory / "mentions.md"
        document.write_text("## Hébergement\n\nConfiguration de test.\n")
        response = await client.get("/api/v2/legal/mentions")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert "Configuration de test" in response.text
        document.write_text("  \n")
        assert (await client.get("/api/v2/legal/mentions")).status_code == 503


def _admin_client(tmp_path, monkeypatch, role="admin"):
    """The legal routes with a test state directory, a fake session and a no-op journal and limiter."""
    events, attempts = [], {"count": 0}

    class Connection:
        async def close(self):
            return None

    async def connect():
        return Connection()

    async def session_user(_connection, request):
        if not request.headers.get("x-test-user"):
            from fastapi import HTTPException
            raise HTTPException(status_code=401, detail="Connectez-vous.")
        return {"id": 7, "username": "admin", "role": request.headers.get("x-test-role", role)}

    async def bump(_connection, _key, _seconds):
        attempts["count"] += 1
        return attempts["count"]

    async def log_event(_connection, event, **fields):
        events.append((event, fields))
        return True
    monkeypatch.setattr(legal, "_state_dir", lambda: tmp_path)
    monkeypatch.setattr(legal, "_connect", connect)
    monkeypatch.setattr(legal, "_session_user", session_user)
    monkeypatch.setattr(auth, "_bump_limit", bump)  # the counter behind per_minute_limit
    monkeypatch.setattr(legal.logbook, "log_event", log_event)
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test")
    return client, events


ADMIN = {"origin": "https://test", "x-test-user": "1"}


@pytest.mark.asyncio
async def test_an_administrator_replaces_a_legal_document_from_a_file(tmp_path, monkeypatch):
    client, events = _admin_client(tmp_path, monkeypatch)
    async with client:
        assert (await client.get("/api/v2/legal")).status_code == 401
        assert (await client.get("/api/v2/legal", headers={**ADMIN, "x-test-role": "confirmed"})).status_code == 403
        listed = (await client.get("/api/v2/legal", headers=ADMIN)).json()
        assert [(item["name"], item["present"], item["sha256"]) for item in listed["documents"]] == [
            ("mentions", False, None), ("confidentialite", False, None), ("conditions", False, None)]
        assert listed["max_bytes"] == 128 * 1024

        first = await client.put("/api/v2/legal/conditions", headers=ADMIN, json={"content": "## Service\r\n\r\nPremière version.\r\n"})
        assert first.status_code == 200, first.text
        path = tmp_path / "legal" / "conditions.md"
        assert path.read_text(encoding="utf-8") == "## Service\n\nPremière version.\n", "line endings normalised"
        assert oct(path.stat().st_mode & 0o777) == "0o600" and oct((tmp_path / "legal").stat().st_mode & 0o777) == "0o700"
        assert (await client.get("/api/v2/legal/conditions")).text == "## Service\n\nPremière version.\n"

        stale = await client.put("/api/v2/legal/conditions", headers=ADMIN, json={"content": "Autre", "expected_sha256": None})
        assert stale.status_code == 409, "a document changed since it was listed is not overwritten"
        second = await client.put("/api/v2/legal/conditions", headers=ADMIN,
                                  json={"content": "## Service\n\nDeuxième version.\n", "expected_sha256": first.json()["sha256"]})
        assert second.status_code == 200 and second.json()["bytes"] == len("## Service\n\nDeuxième version.\n".encode())
        assert (tmp_path / "legal" / "conditions.previous.md").read_text(encoding="utf-8") == "## Service\n\nPremière version.\n"
        assert (await client.get("/api/v2/legal/conditions")).text.endswith("Deuxième version.\n")
        assert sorted(p.name for p in (tmp_path / "legal").iterdir()) == ["conditions.md", "conditions.previous.md"], "no temporary file left"
    assert events == [("legal.document.updated", {"document": "conditions", "bytes": 31}),
                      ("legal.document.updated", {"document": "conditions", "bytes": len("## Service\n\nDeuxième version.\n".encode())})]


@pytest.mark.asyncio
async def test_a_legal_document_that_cannot_be_served_is_refused(tmp_path, monkeypatch):
    client, events = _admin_client(tmp_path, monkeypatch)
    async with client:
        assert (await client.put("/api/v2/legal/other", headers=ADMIN, json={"content": "x"})).status_code == 404
        assert (await client.put("/api/v2/legal/mentions", headers=ADMIN, json={"content": "  \n "})).status_code == 422
        assert (await client.put("/api/v2/legal/mentions", headers=ADMIN, json={"content": "a\x00b"})).status_code == 422
        large = "é" * (64 * 1024 + 1)  # under the character limit, over 128 KiB in UTF-8
        assert (await client.put("/api/v2/legal/mentions", headers=ADMIN, json={"content": large})).status_code == 422
        assert (await client.put("/api/v2/legal/mentions", headers={**ADMIN, "origin": "https://elsewhere.example"},
                                 json={"content": "x"})).status_code == 403
        assert (await client.put("/api/v2/legal/mentions", headers={**ADMIN, "x-test-role": "confirmed"},
                                 json={"content": "x"})).status_code == 403
        (tmp_path / "legal").mkdir()
        (tmp_path / "elsewhere.md").write_text("ailleurs")
        (tmp_path / "legal" / "mentions.md").symlink_to(tmp_path / "elsewhere.md")
        refused = await client.put("/api/v2/legal/mentions", headers=ADMIN, json={"content": "## Nouveau"})
        assert refused.status_code == 503 and (tmp_path / "elsewhere.md").read_text() == "ailleurs", "a link is never followed"
    assert events == []


@pytest.mark.asyncio
async def test_legal_updates_are_limited(tmp_path, monkeypatch):
    client, _events = _admin_client(tmp_path, monkeypatch)
    monkeypatch.setattr(legal, "UPDATES_PER_MINUTE", 1)
    async with client:
        assert (await client.put("/api/v2/legal/mentions", headers=ADMIN, json={"content": "## Un"})).status_code == 200
        limited = await client.put("/api/v2/legal/mentions", headers=ADMIN, json={"content": "## Deux"})
        assert limited.status_code == 429 and limited.headers["retry-after"] == "60"


@pytest.mark.asyncio
async def test_a_failed_copy_of_the_replaced_version_leaves_no_temporary_file(tmp_path, monkeypatch):
    client, _events = _admin_client(tmp_path, monkeypatch)
    async with client:
        first = await client.put("/api/v2/legal/mentions", headers=ADMIN, json={"content": "## Un"})
        assert first.status_code == 200
        opened, fdopen = {"count": 0}, legal.os.fdopen

        def fail_on_the_copy(descriptor, *args, **kwargs):
            opened["count"] += 1
            if opened["count"] == 2:  # the first opens the new text, the second the copy of the replaced one
                raise OSError("disk full")
            return fdopen(descriptor, *args, **kwargs)
        monkeypatch.setattr(legal.os, "fdopen", fail_on_the_copy)
        refused = await client.put("/api/v2/legal/mentions", headers=ADMIN,
                                   json={"content": "## Deux", "expected_sha256": first.json()["sha256"]})
        assert refused.status_code == 503 and opened["count"] == 2
    directory = tmp_path / "legal"
    assert [p.name for p in directory.iterdir() if p.name.startswith(".")] == [], "no temporary file left"
    assert (directory / "mentions.md").read_text(encoding="utf-8") == "## Un"
