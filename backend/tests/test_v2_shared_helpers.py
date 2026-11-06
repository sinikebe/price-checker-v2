"""The helpers the routers share: the administrator guard, GTIN rules, Paris days, jsonb, state files."""
from __future__ import annotations

import json
from datetime import UTC, date, datetime

import pytest
from fastapi import HTTPException

from app.api.v2 import setup
from app.api.v2.auth import _require_admin_role
from app.core.paris_time import PARIS, paris_day, paris_noon
from app.core.state_files import aware_datetime, read_json_object, write_atomic, write_json_atomic
from app.db.v2_json import decoded
from app.services.barcodes import is_gtin, normalize_barcode, valid_check_digit


def test_only_an_administrator_passes_the_guard():
    admin = {"id": 1, "username": "admin", "role": "admin"}
    assert _require_admin_role(admin) is admin
    with pytest.raises(HTTPException) as anonymous:
        _require_admin_role(None)
    assert (anonymous.value.status_code, anonymous.value.detail) == (403, "Accès administrateur requis.")
    with pytest.raises(HTTPException) as visitor:
        _require_admin_role({"id": 2, "username": "ana", "role": "visitor"}, "Réservé à l'administrateur.")
    assert (visitor.value.status_code, visitor.value.detail) == (403, "Réservé à l'administrateur.")
    with pytest.raises(HTTPException):
        _require_admin_role({"id": 3, "username": "ben", "role": "confirmed"})


def test_a_gtin_is_8_12_13_or_14_ascii_digits():
    for code in ("12345670", "036000291452", "3017620422003", "13017620422000"):
        assert is_gtin(code), code
    for code in ("", "123456789", "1234567", "301762042200x", "١٢٣٤٥٦٧٨", " 12345670", "123456789012345"):
        assert not is_gtin(code), code
    assert normalize_barcode(" 3017620422003 ") == "3017620422003"
    with pytest.raises(HTTPException) as refused:
        normalize_barcode("١٢٣٤٥٦٧٨")
    assert (refused.value.status_code, refused.value.detail) == (422, "Code-barres invalide.")


def test_the_check_digit_follows_gs1():
    for code in ("96385074", "036000291452", "3017620422003", "4006381333931", "13017620422000"):
        assert valid_check_digit(code), code
    for code in ("96385075", "036000291453", "3017620422004"):
        assert not valid_check_digit(code), code


def test_a_moment_is_dated_by_its_paris_day_and_a_day_stored_at_paris_noon():
    assert paris_day(datetime(2026, 11, 2, 23, 30, tzinfo=UTC)) == "2026-11-03"
    assert paris_day(datetime(2026, 7, 1, 21, 59, tzinfo=UTC)) == "2026-07-01"
    noon = paris_noon(date(2026, 11, 2))
    assert (noon.hour, noon.tzinfo, noon.utcoffset().total_seconds()) == (12, PARIS, 3600)


def test_jsonb_text_is_decoded_and_anything_else_passes_through():
    assert decoded('{"a": [1]}') == {"a": [1]}
    value = {"a": 1}
    assert decoded(value) is value
    assert decoded(None) is None


def test_a_state_file_is_written_whole_with_its_mode_and_read_back_bounded(tmp_path):
    target = tmp_path / "request.json"
    write_json_atomic(target, {"id": "é"})
    assert target.stat().st_mode & 0o777 == 0o600
    assert target.read_bytes() == json.dumps({"id": "é"}).encode()
    assert read_json_object(target, 100) == {"id": "é"}
    write_json_atomic(target, {"id": 2}, mode=0o644)
    assert target.stat().st_mode & 0o777 == 0o644 and json.loads(target.read_text()) == {"id": 2}
    with pytest.raises(FileExistsError):
        write_atomic(target, b"{}", exclusive=True)
    assert json.loads(target.read_text()) == {"id": 2}, "an exclusive write keeps the existing file"
    for content in ("[]", "1", "not json", "{" + " " * 200 + "}"):
        target.write_text(content)
        with pytest.raises(ValueError):
            read_json_object(target, 100)
    with pytest.raises(FileNotFoundError):
        read_json_object(tmp_path / "missing.json", 100)
    assert [item.name for item in tmp_path.iterdir()] == ["request.json"], "no temporary file is left"


def test_only_a_moment_with_its_time_zone_is_accepted():
    assert aware_datetime("2026-11-02T10:00:00+01:00") == datetime(2026, 11, 2, 9, 0, tzinfo=UTC)
    for value in ("2026-11-02T10:00:00", "soon", None, 3):
        assert aware_datetime(value) is None, value


def test_the_first_setup_and_the_access_code_are_written_once(tmp_path, monkeypatch):
    monkeypatch.setenv("PRICE_CHECKER_V2_STATE_DIR", str(tmp_path))
    code = setup._access_code()
    assert setup._access_code() == code and (tmp_path / "access-code").stat().st_mode & 0o777 == 0o600
    setup._save_config({"host": "db"}, first_setup=True)
    with pytest.raises(HTTPException) as again:
        setup._save_config({"host": "other"}, first_setup=True)
    assert (again.value.status_code, again.value.detail) == (409, "La V2 est déjà configurée.")
    assert json.loads((tmp_path / "database.json").read_text()) == {"host": "db"}
    setup._save_config({"host": "other"}, first_setup=False)
    assert json.loads((tmp_path / "database.json").read_text()) == {"host": "other"}
    assert (tmp_path / "database.json").stat().st_mode & 0o777 == 0o600
    assert sorted(item.name for item in tmp_path.iterdir()) == ["access-code", "database.json"]
