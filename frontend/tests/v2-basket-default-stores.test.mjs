import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-basket-default-stores.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const values = new Map();
globalThis.localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: key => values.delete(key),
};
const { BASKET_DEFAULT_STORES_KEY, readBasketDefaultStores, writeBasketDefaultStores } =
  await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

test("default stores persist on this browser independently of basket account keys", () => {
  values.clear();
  writeBasketDefaultStores([{ id: 12, name: "Marché · Centre" }, { id: 34, name: "Épicerie · Nord" }]);
  assert.deepEqual(readBasketDefaultStores(), [{ id: 12, name: "Marché · Centre" }, { id: 34, name: "Épicerie · Nord" }]);
  assert.equal(values.has("v2:basket:anonymous"), false);
  writeBasketDefaultStores([]);
  assert.deepEqual(readBasketDefaultStores(), []);
  assert.equal(values.has(BASKET_DEFAULT_STORES_KEY), false);
});

test("corrupt or obsolete local entries cannot become store filters", () => {
  values.set(BASKET_DEFAULT_STORES_KEY, JSON.stringify([
    { id: 12, name: "Marché" }, { id: 12, name: "Doublon" }, { id: -1, name: "Invalide" },
    { id: "34", name: "Ancien format" }, { id: 56, name: "" },
  ]));
  assert.deepEqual(readBasketDefaultStores(), [{ id: 12, name: "Marché" }]);
  values.set(BASKET_DEFAULT_STORES_KEY, "broken");
  assert.deepEqual(readBasketDefaultStores(), []);
});
