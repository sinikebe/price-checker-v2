"""A pack can have several measures: weight, volume and a piece count."""

from decimal import Decimal

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.v2.duplicate_merges import PRODUCT_FIELDS
from app.api.v2.products import ProductData, _material_change, _validate_publish
from app.services.quantity_parser import parse_measures


def measures(data: ProductData) -> list[tuple[str, str]]:
    return [(str(item.amount), item.unit) for item in data.measures]


def test_a_single_quantity_is_one_measure():
    parsed = parse_measures("250 g")
    assert [(item.amount, item.unit) for item in parsed] == [(Decimal("250.000"), "g")]
    assert parse_measures("12 pièces")[0].unit == "piece"


def test_a_multipack_is_a_weight_and_a_piece_count():
    parsed = parse_measures("4x125g")
    assert [(item.amount, item.unit) for item in parsed] == [
        (Decimal("500.000"), "g"),
        (Decimal("4.000"), "piece"),
    ]
    assert [(item.amount, item.unit) for item in parse_measures("6 x 1L")] == [
        (Decimal("6000.000"), "ml"),
        (Decimal("6.000"), "piece"),
    ]
    # A multipack counted in pieces already is the count.
    assert [item.unit for item in parse_measures("3x4 pièces")] == ["piece"]


def test_unreadable_text_gives_no_measure():
    for text in (None, "", "environ 500 g", "2x3x100g", "4x", "0 g", "6 bouteilles"):
        assert parse_measures(text) == []


def test_product_data_lists_every_measure_main_one_first():
    data = ProductData(quantity="4x125g")
    assert measures(data) == [("500.000", "g"), ("4.000", "piece")]
    # The classic fields stay the main measure, as before.
    assert (data.quantity_amount, data.quantity_unit) == (Decimal("500.000"), "g")


def test_extra_quantities_add_units_and_a_client_cannot_set_measures():
    data = ProductData.model_validate({
        "quantity": "250 g",
        "extra_quantities": [{"amount": "1", "unit": "piece"}],
        "measures": [{"amount": "9", "unit": "ml"}],
        "quantity_amount": "7",
        "quantity_unit": "ml",
    })
    assert measures(data) == [("250.000", "g"), ("1.000", "piece")]
    assert (data.quantity_amount, data.quantity_unit) == (Decimal("250.000"), "g")


def test_an_extra_replaces_the_pieces_derived_from_a_multipack():
    data = ProductData(
        quantity="4x125g", extra_quantities=[{"amount": "5", "unit": "piece"}]
    )
    assert measures(data) == [("500.000", "g"), ("5.000", "piece")]


def test_extras_work_when_the_text_cannot_be_read():
    data = ProductData(
        quantity="30 tablettes", extra_quantities=[{"amount": "30", "unit": "piece"}]
    )
    assert measures(data) == [("30.000", "piece")]
    assert (data.quantity_amount, data.quantity_unit) == (Decimal("30.000"), "piece")


@pytest.mark.parametrize(
    "extra",
    [
        {"amount": "0", "unit": "g"},
        {"amount": "-1", "unit": "g"},
        {"amount": "1000000000", "unit": "g"},
        {"amount": "1.5", "unit": "piece"},
        {"amount": "1.2345", "unit": "g"},
        {"amount": "abc", "unit": "g"},
        {"amount": "1", "unit": "kg"},
        {"amount": "1", "unit": "rouleau"},
    ],
)
def test_invalid_extras_are_refused(extra):
    with pytest.raises(ValidationError):
        ProductData(extra_quantities=[extra])


def test_one_value_per_unit_and_never_the_text_unit_again():
    with pytest.raises(ValidationError):
        ProductData(extra_quantities=[
            {"amount": "1", "unit": "g"}, {"amount": "2", "unit": "g"}])
    with pytest.raises(ValidationError):
        ProductData(quantity="250 g", extra_quantities=[{"amount": "300", "unit": "g"}])
    with pytest.raises(ValidationError):
        ProductData(extra_quantities=[
            {"amount": "1", "unit": "g"}, {"amount": "1", "unit": "ml"},
            {"amount": "1", "unit": "piece"}, {"amount": "2", "unit": "piece"}])


def test_old_products_without_the_new_fields_get_their_measures():
    stored = {"name": "Riz", "quantity": "1 kg", "quantity_amount": "1000.000",
              "quantity_unit": "g", "quantity_count_noun": None}
    data = ProductData.model_validate(stored)
    assert data.extra_quantities == []
    assert measures(data) == [("1000.000", "g")]
    assert ProductData.model_validate(data.model_dump(mode="json")) == data


def test_derived_measures_are_not_merge_fields_but_extras_are():
    assert "measures" not in PRODUCT_FIELDS
    assert "extra_quantities" in PRODUCT_FIELDS


def test_publication_refuses_non_ascii_digits_in_the_barcode():
    base = ProductData(name="Riz", brand="X", package="Sachet", quantity="1 kg")
    ok = base.model_dump(mode="json") | {"ean": "3017620422003"}
    _validate_publish(ok)
    # Arabic-indic digits are digits for str.isdigit() but not a barcode.
    bad = ok | {"ean": "٣٠١٧٦٢٠٤٢٢٠٠٣"}
    with pytest.raises(HTTPException) as refused:
        _validate_publish(bad)
    assert refused.value.status_code == 422


def test_only_a_new_package_pack_size_or_recipe_is_a_material_change():
    before = {"package": "Sachet", "quantity": "500 g", "composition": ""}
    after = {"package": "Sachet", "quantity": "500 g", "composition": ""}
    assert not _material_change(before, after)
    assert _material_change(before, after | {"package": "Boîte"})
    assert _material_change(before, after | {"quantity": "750 g"})
    # The same pack written differently, or a unit being fixed, stays a correction.
    assert not _material_change(before, after | {"quantity": "500g"})
    assert not _material_change(before | {"quantity": "0,5 L"}, after | {"quantity": "50 cl"})
    assert not _material_change(before, after | {"quantity": "6 pièces"})
    # Filling a blank composition documents the product; changing a known one does not.
    assert not _material_change(before, after | {"composition": "Riz"})
    assert _material_change(before | {"composition": "Riz"}, after | {"composition": "Riz, sel"})
    assert not _material_change(before | {"composition": "Riz "}, after | {"composition": "Riz"})
    # A field missing from a stored product reads as blank: a quantity given later is no new pack.
    assert not _material_change({"package": "Sachet"}, after)
