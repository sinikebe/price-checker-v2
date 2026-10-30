import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-recipes-product.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { currentRecipeProduct } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

test("recipe import follows multiple approved product replacements to a current SKU", async () => {
  const current = { id: 3, data: { name: "Current butter", quantity_amount: "200", quantity_unit: "g" } };
  const fetched = [];
  const result = await currentRecipeProduct(1, [current], async id => {
    fetched.push(id);
    return { id, successor_id: id === 1 ? 2 : 3 };
  });
  assert.equal(result, current);
  assert.deepEqual(fetched, [1, 2]);
});

test("recipe import follows merges but refuses missing or cyclic references", async () => {
  const current = { id: 8, data: { name: "Current butter" } };
  assert.equal(await currentRecipeProduct(4, [current], async () => ({ id: 4, merged_to_id: 8 })), current);
  assert.equal(await currentRecipeProduct(4, [current], async id =>
    ({ id, successor_id: id === 4 ? 5 : 4 })), null);
  assert.equal(await currentRecipeProduct(4, [current], async () => { throw new Error("withdrawn"); }), null);
});
