import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-catalogue-demo.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { CATALOGUE_DEMO, centsPerKg, demoRanking } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

test("the example has three products: two in one comparable group, the third in another group of the same ensemble", () => {
  const groups = CATALOGUE_DEMO.groups;
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.products.length), [2, 1]);
  for (const group of groups) for (const product of group.products) assert.equal(product.group, group.name);
  assert.ok(CATALOGUE_DEMO.department && CATALOGUE_DEMO.family && CATALOGUE_DEMO.scope);
});

test("comparing the group and the ensemble crowns a different product, per kilogram", () => {
  assert.deepEqual(demoRanking("group").map(product => product.id), ["spaghetti-1000", "spaghetti-500"]);
  assert.deepEqual(demoRanking("scope").map(product => product.id), ["penne-1000", "spaghetti-1000", "spaghetti-500"]);
  assert.equal(centsPerKg(CATALOGUE_DEMO.groups[0].products[0]), 190);
  // The cheapest pack is not the cheapest per kilogram: the example shows why the comparison is per unit.
  const all = CATALOGUE_DEMO.groups.flatMap(group => group.products);
  assert.equal(Math.min(...all.map(product => product.cents)), CATALOGUE_DEMO.groups[0].products[0].cents);
});
