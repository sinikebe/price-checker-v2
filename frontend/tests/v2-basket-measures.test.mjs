import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-measures.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { formatMeasure, measureUnitLabel, parseUnitChoices, readExtraAmount, readUnitChoices, withUnitChoice, writeUnitChoices } =
  await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

test("a measure is written without the server's trailing zeros", () => {
  assert.equal(formatMeasure({ amount: "500.000", unit: "g" }), "500 g");
  assert.equal(formatMeasure({ amount: "1.500", unit: "ml" }), "1,5 ml");
  assert.equal(formatMeasure({ amount: "4.000", unit: "piece" }), "4 pièces");
  assert.equal(formatMeasure({ amount: "1.000", unit: "piece" }), "1 pièce");
  assert.equal(measureUnitLabel("piece", 1), "pièce");
});

test("an extra amount is a positive number with three decimals at most, whole for pieces", () => {
  assert.equal(readExtraAmount("500", "g"), "500");
  assert.equal(readExtraAmount(" 1,5 ", "ml"), "1.5");
  assert.equal(readExtraAmount("0.125", "g"), "0.125");
  assert.equal(readExtraAmount("6", "piece"), "6");
  for (const [text, unit] of [["", "g"], ["0", "g"], ["-2", "g"], ["abc", "g"], ["1e3", "g"], ["1.2345", "g"], ["1.5", "piece"],
    ["1000000000", "g"], ["12 g", "g"], ["1,5,2", "g"], ["٣", "g"]])
    assert.equal(readExtraAmount(text, unit), null, `${text} ${unit}`);
});

test("stored unit choices keep only valid units and a bounded number of entries", () => {
  assert.deepEqual(parseUnitChoices({ "product:1": "piece", "group:x": "g", "product:2": "kg", "product:3": 3, "": "ml" }),
    { "product:1": "piece", "group:x": "g" });
  for (const bad of [null, "g", 3, ["g"], undefined]) assert.deepEqual(parseUnitChoices(bad), {});
  const many = Object.fromEntries(Array.from({ length: 300 }, (_, index) => ["product:" + index, "g"]));
  assert.equal(Object.keys(parseUnitChoices(many)).length, 100);
});

test("choosing a unit sets one article, clears it with null and forgets articles that left the basket", () => {
  const keep = ["product:1", "product:2"];
  let choices = withUnitChoice({}, "product:1", "piece", keep);
  assert.deepEqual(choices, { "product:1": "piece" });
  choices = withUnitChoice(choices, "product:2", "ml", keep);
  assert.deepEqual(choices, { "product:1": "piece", "product:2": "ml" });
  assert.deepEqual(withUnitChoice(choices, "product:1", null, keep), { "product:2": "ml" });
  assert.deepEqual(withUnitChoice(choices, "product:2", "g", ["product:2"]), { "product:2": "g" }, "product:1 left the basket");
  assert.deepEqual(withUnitChoice(choices, "product:9", "g", keep), choices, "not in the basket: nothing to keep");
});

test("unit choices are kept in the browser per account and survive unavailable storage", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } };
  writeUnitChoices(7, { "product:1": "piece" });
  writeUnitChoices(null, { "group:riz": "g" });
  assert.deepEqual(readUnitChoices(7), { "product:1": "piece" });
  assert.deepEqual(readUnitChoices(null), { "group:riz": "g" });
  assert.deepEqual(readUnitChoices(8), {});
  store.set("v2:basket:units:7", "{broken");
  assert.deepEqual(readUnitChoices(7), {});
  globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual(readUnitChoices(7), {});
  assert.doesNotThrow(() => writeUnitChoices(7, { "product:1": "g" }));
  delete globalThis.localStorage;
});
