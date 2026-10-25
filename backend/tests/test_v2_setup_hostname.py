"""Hostnames used on private development networks and public servers."""

import pytest
from fastapi import HTTPException

from app.api.v2.setup import _validated_hostname


@pytest.mark.parametrize("value", ["dev-price-checker", "machine.local", "localhost", "192.168.1.244"])
def test_local_hostname_is_accepted_in_development(value):
    assert _validated_hostname(value, allow_local=True) == value


@pytest.mark.parametrize("value", ["dev-price-checker", "localhost", "192.168.1.244"])
def test_local_hostname_is_rejected_in_production(value):
    with pytest.raises(HTTPException) as exc:
        _validated_hostname(value)
    assert exc.value.status_code == 422


def test_public_domain_is_accepted():
    assert _validated_hostname(" Exemple.ORG ") == "exemple.org"


@pytest.mark.parametrize("value", ["https://machine.local", "machine.local:3001", "machine.local/path", "999.999.999.999"])
def test_invalid_hostname_is_rejected_in_development(value):
    with pytest.raises(HTTPException) as exc:
        _validated_hostname(value, allow_local=True)
    assert exc.value.status_code == 422


@pytest.mark.asyncio
async def test_dev_hostname_can_be_cleared_but_production_cannot(monkeypatch):
    from types import SimpleNamespace

    import httpx

    from app.api.v2 import setup
    from app.main_v2 import app

    config = {"public_hostname": "dev.local"}
    async def admin_ok(_request):
        return None
    monkeypatch.setattr(setup, "_require_admin", admin_ok)
    monkeypatch.setattr(setup, "_read_config", lambda: config)
    monkeypatch.setattr(setup, "_save_config", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(setup, "get_settings", lambda: SimpleNamespace(APP_ENV="dev"))
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 1234))
    async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
        cleared = await client.put(
            "/api/v2/setup/hostname",
            json={"public_hostname": "", "expected_hostname": "dev.local"},
        )
        assert cleared.status_code == 200
        assert cleared.json()["public_hostname"] == ""
        config["public_hostname"] = "example.org"
        monkeypatch.setattr(setup, "get_settings", lambda: SimpleNamespace(APP_ENV="prod"))
        refused = await client.put(
            "/api/v2/setup/hostname",
            json={"public_hostname": "", "expected_hostname": "example.org"},
        )
        assert refused.status_code == 422
