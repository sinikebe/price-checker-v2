import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-basket-quantity.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { combineQuantities, pricedQuantity, productSize, productSizes, productSizeIn, purchaseDemand, microUnits } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

test("recipe quantities add across compatible units without including a default package", () => {
  assert.deepEqual(combineQuantities(undefined, { amount: "20", unit: "g" }), { amount: "20", unit: "g" });
  assert.deepEqual(combineQuantities({ amount: "20", unit: "g" }, { amount: "0.5", unit: "kg" }), { amount: "520", unit: "g" });
  assert.equal(combineQuantities({ amount: "20", unit: "g" }, { amount: "50", unit: "ml" }), null);
});

test("package requests buy whole packs and physical requests need a known matching size", () => {
  const product = { data: { quantity_amount: "250", quantity_unit: "g" } };
  assert.deepEqual(pricedQuantity({ quantity: { amount: "2.5", unit: "package" } }, product, 250, true),
    { packages: 3, cents: 750, usedCents: 625, used: true });
  assert.equal(pricedQuantity({ quantity: { amount: "20", unit: "ml" } }, product, 250, true), null);
  assert.deepEqual(pricedQuantity({ quantity: { amount: "20", unit: "g" } }, product, 250, true),
    { packages: 1, cents: 250, usedCents: 20, used: true });
});

test("package counts add exactly, so the merged quantity stays valid", () => {
  assert.deepEqual(combineQuantities({ amount: "0.1", unit: "package" }, { amount: "0.2", unit: "package" }), { amount: "0.3", unit: "package" });
  assert.deepEqual(combineQuantities({ amount: "2", unit: "package" }, { amount: "1.5", unit: "package" }), { amount: "3.5", unit: "package" });
  assert.equal(combineQuantities({ amount: "999999", unit: "package" }, { amount: "1", unit: "package" }), null);
});

test("a pack size is read from the catalogue only when it is a positive amount in g, ml or pieces", () => {
  assert.deepEqual(productSize({ data: { quantity_amount: "250", quantity_unit: "g" } }), { amount: 250, unit: "g" });
  assert.deepEqual(productSize({ data: { quantity_amount: "0.5", quantity_unit: "ml" } }), { amount: 0.5, unit: "ml" });
  for (const data of [{}, { quantity_amount: "0", quantity_unit: "g" }, { quantity_amount: "-3", quantity_unit: "g" },
    { quantity_amount: "12", quantity_unit: "kg" }, { quantity_amount: "x", quantity_unit: "g" }, { quantity_amount: null, quantity_unit: "g" }])
    assert.equal(productSize({ data }), null, JSON.stringify(data));
  assert.equal(microUnits(0.5), 500000n);
});

test("a pack can be measured in several units, one size per unit, the main one first", () => {
  const data = { quantity_amount: "500", quantity_unit: "g", measures: [
    { amount: "500.000", unit: "g", count_noun: null }, { amount: "4.000", unit: "piece", count_noun: null }] };
  assert.deepEqual(productSizes({ data }), [{ amount: 500, unit: "g" }, { amount: 4, unit: "piece" }]);
  assert.deepEqual(productSize({ data }), { amount: 500, unit: "g" });
  assert.deepEqual(productSizeIn({ data }, "piece"), { amount: 4, unit: "piece" });
  assert.equal(productSizeIn({ data }, "ml"), null);
  // Bad or repeated entries are ignored; the first of a unit wins.
  const messy = { measures: [{ amount: "0", unit: "g" }, { amount: "x", unit: "ml" }, { amount: "2", unit: "kg" },
    { amount: "3", unit: "piece" }, { amount: "9", unit: "piece" }] };
  assert.deepEqual(productSizes({ data: messy }), [{ amount: 3, unit: "piece" }]);
});

test("a copy without measures keeps its single quantity", () => {
  assert.deepEqual(productSizes({ data: { quantity_amount: "250", quantity_unit: "g" } }), [{ amount: 250, unit: "g" }]);
  assert.deepEqual(productSizes({ data: { measures: [], quantity_amount: "250", quantity_unit: "g" } }), [{ amount: 250, unit: "g" }]);
  assert.deepEqual(productSizes({ data: {} }), []);
});

test("a requested physical quantity uses the product's size in that unit", () => {
  const product = { data: { quantity_amount: "4", quantity_unit: "piece", measures: [
    { amount: "4.000", unit: "piece", count_noun: null }, { amount: "500.000", unit: "g", count_noun: null }] } };
  assert.deepEqual(pricedQuantity({ quantity: { amount: "1", unit: "kg" } }, product, 200, true),
    { packages: 2, cents: 400, usedCents: 400, used: true });
  const demand = purchaseDemand({ quantity: { amount: "750", unit: "g" } }, product, true);
  assert.equal(demand.demand * 2n, demand.capacity * 3n, "750 g of a 500 g pack is 1.5 packs");
  assert.equal(pricedQuantity({ quantity: { amount: "1", unit: "l" } }, product, 200, true), null, "no volume known");
  assert.equal(purchaseDemand({ quantity: { amount: "1", unit: "l" } }, product, true), null);
});
