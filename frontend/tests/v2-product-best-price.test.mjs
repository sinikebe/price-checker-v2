import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const load = async file => {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
};
const { bestPrice, readingPlace } = await load("../src/v2/v2-product-best-price.ts");
const { decimalText, plainDecimal } = await load("../src/recipes/quantity.ts");

const reading = (price, extra = {}) => ({ price, observed_at: "2026-11-01", retailer: "Shop", store_name: "Centre", city: "Paris", ...extra });

test("the best price is the lowest usable reading, and the stores counted are the usable ones", () => {
  const best = bestPrice([reading("2.50"), reading("1.10", { available: false }), reading("0.90", { correction_status: "active" }), reading("1.99")]);
  assert.equal(best.cents, 199);
  assert.equal(best.stores, 2);
  assert.equal(bestPrice([]), null);
  assert.equal(bestPrice([reading("1.00", { available: false })]), null);
});

test("on a tie the most recent reading wins; an online platform reads as online", () => {
  const best = bestPrice([reading("2.00"), reading("2.00", { observed_at: "2026-11-03", store_name: "Market", city: null, online: true })]);
  assert.equal(best.reading.store_name, "Market");
  assert.equal(readingPlace(best.reading), "Shop · Market · en ligne");
  assert.equal(readingPlace(reading("1")), "Shop · Centre · Paris");
});

test("portions lose their padding zeros", () => {
  assert.equal(plainDecimal("2.000"), "2");
  assert.equal(plainDecimal("1.500"), "1.5");
  assert.equal(plainDecimal("10"), "10");
  assert.equal(plainDecimal("20.000"), "20");
  assert.equal(decimalText("1.250"), "1,25");
  assert.equal(decimalText("2.000"), "2");
});
