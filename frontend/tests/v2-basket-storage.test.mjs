import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-basket-storage.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key),
};
globalThis.window = { dispatchEvent: () => {} };
const { readV2Basket, writeV2Basket, activateBasketUser } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
const product = { id: 1, revision: 1, data: { name: "Jus" } };
const group = { kind: "group", name: "Jus d'orange" };
const scope = { kind: "scope", name: "Jus", department: "Boissons", family: "Jus de fruits" };

test("legacy product baskets remain readable alongside groups and ensembles", () => {
  storage.clear();
  storage.set("v2:basket:anonymous", JSON.stringify([product]));
  assert.deepEqual(readV2Basket(null), [product]);
  writeV2Basket([product, group, scope], null);
  assert.deepEqual(readV2Basket(null), [product, group, scope]);
});

test("login merges offline entries without duplicating an existing group", () => {
  storage.clear();
  writeV2Basket([product, group, scope], null);
  writeV2Basket([group], 42);
  activateBasketUser(42);
  assert.deepEqual(readV2Basket(42), [group, product, scope]);
  assert.deepEqual(readV2Basket(null), []);
});


test("disabled articles remain in the local basket without changing identity", () => {
  storage.clear();
  writeV2Basket([{ ...group, disabled: true }, product], null);
  assert.deepEqual(readV2Basket(null), [{ ...group, disabled: true }, product]);
});
