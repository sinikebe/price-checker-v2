"""Barcodes (EAN / GTIN) as the API accepts them."""

from __future__ import annotations

from fastapi import HTTPException


def is_gtin(value: str) -> bool:
    """Whether `value` is 8, 12, 13 or 14 ASCII digits, as written (spaces are not removed)."""
    return value.isascii() and value.isdigit() and len(value) in {8, 12, 13, 14}


def normalize_barcode(raw: str) -> str:
    """8, 12, 13 or 14 ASCII digits, surrounding spaces removed; anything else is refused (422)."""
    value = raw.strip()
    if not is_gtin(value):
        raise HTTPException(status_code=422, detail="Code-barres invalide.")
    return value


def valid_check_digit(barcode: str) -> bool:
    """The GS1 check digit of an EAN-8, UPC-A, EAN-13 or GTIN-14."""
    digits = [int(char) for char in barcode]
    total = sum(digit * (3 if index % 2 == 0 else 1) for index, digit in enumerate(reversed(digits[:-1])))
    return (10 - total % 10) % 10 == digits[-1]
