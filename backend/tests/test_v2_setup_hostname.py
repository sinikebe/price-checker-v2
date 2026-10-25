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
