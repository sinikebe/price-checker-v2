import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-basket-comparison.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { buildBasketComparison, postalDepartment } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

const product = id => ({ id, revision: 1, data: { name: "Product " + id } });
const line = (item, ...candidates) => ({ item, candidates });
const reading = (id, storeId, price, extra = {}) => ({
  id, price, observed_at: "2026-10-20", retailer: "Shop", store_name: "Store " + storeId,
  store_id: storeId, city: "Paris", postal_code: "75001", sales_channel: "in_store",
  available: true, correction_status: null, source_provider: null, ...extra,
});
const response = (...rows) => ({ latest_by_store: rows, stores_truncated: false });

test("a store total is complete only with all articles; split uses eligible readings", () => {
  const products = [product(1), product(2), product(3)];
  const results = new Map([
    [1, response(reading(1, 10, "2.50"), reading(2, 20, "1.75"))],
    [2, response(reading(3, 10, "3.00"), reading(4, 20, "0.99", { available: false }),
      reading(5, 30, "2.10"))],
    [3, response(reading(6, 10, "1.25"), reading(7, 30, "0.50", { correction_status: "active" }))],
  ]);
  const comparison = buildBasketComparison(products.map(item => line(item, item)), results);
  assert.equal(comparison.stores[0].key, "10:in_store");
  assert.equal(comparison.stores[0].coverage, 3);
  assert.equal(comparison.stores[0].cents, 675);
  assert.equal(comparison.stores.find(store => store.key === "20:in_store").coverage, 1);
  assert.equal(comparison.splitCents, 510);
  assert.deepEqual(comparison.split.map(choice => choice.reading.id), [2, 5, 6]);
  assert.deepEqual(comparison.missing, []);
});

test("group and ensemble each count once and select one product per store", () => {
  const group = { kind: "group", name: "Jus d'orange" };
  const scope = { kind: "scope", name: "Jus", department: "Boissons", family: "Jus de fruits" };
  const products = [product(1), product(2), product(3)];
  const comparison = buildBasketComparison([
    line(group, products[0], products[1]), line(scope, products[1], products[2]),
  ], new Map([
    [1, response(reading(1, 10, "2.50"), reading(2, 20, "2.00"))],
    [2, response(reading(3, 10, "1.80"), reading(4, 20, "1.90"))],
    [3, response(reading(5, 10, "3.00"), reading(6, 20, "1.50"))],
  ]));
  assert.equal(comparison.stores.find(store => store.key === "10:in_store").cents, 360);
  assert.deepEqual(comparison.stores.find(store => store.key === "10:in_store").choices.map(choice => choice.product.id), [2, 2]);
  assert.equal(comparison.splitCents, 330);
  assert.deepEqual(comparison.split.map(choice => choice.product.id), [2, 3]);
});

test("filters allow several stores, cities or departments and limit both comparison views", () => {
  const item = product(1);
  const results = new Map([[1, response(
    reading(1, 10, "2.00", { city: "Paris", postal_code: "75001" }),
    reading(2, 20, "1.00", { city: "Lyon", postal_code: "69001" }),
    reading(3, 30, "0.50", { city: "Marseille", postal_code: "13001" }),
  )]]);
  const comparison = buildBasketComparison([line(item, item)], results, {
    storeIds: [10, 20], cities: ["Paris", "Lyon"], departments: ["75", "69"],
  });
  assert.deepEqual(comparison.stores.map(store => store.key), ["20:in_store", "10:in_store"]);
  assert.equal(comparison.splitCents, 100);
  assert.equal(buildBasketComparison([line(item, item)], results, {
    storeIds: [], cities: [], departments: ["13"],
  }).splitCents, 50);
});

test("failed candidates do not yield a misleading minimum for a group", () => {
  const group = { kind: "group", name: "Beans" };
  const comparison = buildBasketComparison([line(group, product(1), product(2))], new Map([
    [1, response(reading(1, 10, "1.00"))], [2, null],
  ]));
  assert.deepEqual(comparison.failed, [group]);
  assert.equal(comparison.stores.length, 0);
});

test("missing and failed products never produce a complete total", () => {
  const products = [product(1), product(2), product(3)];
  const comparison = buildBasketComparison(products.map(item => line(item, item)), new Map([
    [1, response(reading(1, 10, "2.00"))],
    [2, response(reading(2, 10, "0.99", { available: false }))],
    [3, null],
  ]));
  assert.equal(comparison.splitCents, 200);
  assert.equal(comparison.stores[0].coverage, 1);
  assert.deepEqual(comparison.missing.map(item => item.id), [2, 3]);
  assert.deepEqual(comparison.failed.map(item => item.id), [3]);
});

test("ties prefer newer readings, while store and drive remain separate", () => {
  const item = product(1);
  const comparison = buildBasketComparison([line(item, item)], new Map([
    [1, response(reading(1, 10, "1.50", { observed_at: "2026-10-01" }),
      reading(2, 10, "1.50", { observed_at: "2026-10-24", sales_channel: "drive" }))],
  ]));
  assert.equal(comparison.split[0].reading.id, 2);
  assert.deepEqual(new Set(comparison.stores.map(store => store.key)), new Set(["10:drive", "10:in_store"]));
});

test("department extraction handles mainland, Corsica and overseas postal codes", () => {
  assert.deepEqual(["75001", "20190", "20200", "97100", "97410", "abc"].map(postalDepartment),
    ["75", "2A", "2B", "971", "974", null]);
});
