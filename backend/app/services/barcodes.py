"""Barcodes (EAN / GTIN) as the API accepts them."""

from __future__ import annotations

from fastapi import HTTPException


def normalize_barcode(raw: str) -> str:
    """8, 12, 13 or 14 ASCII digits, surrounding spaces removed; anything else is refused (422)."""
    value = raw.strip()
    if not value.isascii() or not value.isdigit() or len(value) not in {8, 12, 13, 14}:
        raise HTTPException(status_code=422, detail="Code-barres invalide.")
    return value
