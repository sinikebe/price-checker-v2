import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-basket-product.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { currentBasketProduct } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

test("recipe import follows multiple approved product replacements to a current SKU", async () => {
  const current = { id: 3, data: { name: "Current butter", quantity_amount: "200", quantity_unit: "g" } };
  const fetched = [];
  const result = await currentBasketProduct(1, [current], async id => {
    fetched.push(id);
    return { id, successor_id: id === 1 ? 2 : 3 };
  });
  assert.equal(result, current);
  assert.deepEqual(fetched, [1, 2]);
});

test("recipe import follows merges but refuses missing or cyclic references", async () => {
  const current = { id: 8, data: { name: "Current butter" } };
  assert.equal(await currentBasketProduct(4, [current], async () => ({ id: 4, merged_to_id: 8 })), current);
  assert.equal(await currentBasketProduct(4, [current], async id =>
    ({ id, successor_id: id === 4 ? 5 : 4 })), null);
  assert.equal(await currentBasketProduct(4, [current], async () => { throw new Error("withdrawn"); }), null);
});

test("saved basket products resolve to current published replacement or fail closed", async () => {
  const current = { id: 9, data: { name: "200 g butter", quantity_amount: "200.000", quantity_unit: "g" } };
  assert.equal(await currentBasketProduct(7, null, async id =>
    id === 7 ? { id: 7, successor_id: 9 } : current), current);
  assert.equal(await currentBasketProduct(7, null, async () => { throw new Error("withdrawn"); }), null);
});
