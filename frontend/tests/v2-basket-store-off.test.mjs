import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-basket-store-off.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { MAX_STORES_OFF, parseStoresOff, readStoresOff, withStoreOff, writeStoresOff } =
  await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

test("stored stores off keep only store and channel keys, once each, bounded", () => {
  assert.deepEqual(parseStoresOff(["45:drive", "45:drive", "1:in_store", "x:drive", "2:bike", 3, "12:delivery"]), ["45:drive", "1:in_store", "12:delivery"]);
  for (const bad of [null, "45:drive", {}, 3, undefined]) assert.deepEqual(parseStoresOff(bad), []);
  assert.equal(parseStoresOff(Array.from({ length: 80 }, (_, index) => `${index + 1}:drive`)).length, MAX_STORES_OFF);
});

test("switching a store off and on again", () => {
  let keys = withStoreOff([], "45:drive", true);
  assert.deepEqual(keys, ["45:drive"]);
  keys = withStoreOff(keys, "1:in_store", true);
  assert.deepEqual(withStoreOff(keys, "45:drive", true), ["1:in_store", "45:drive"], "no duplicate");
  assert.deepEqual(withStoreOff(keys, "45:drive", false), ["1:in_store"]);
  assert.deepEqual(withStoreOff(keys, "not a key", true), keys);
});

test("the stores off are kept per account and survive unavailable storage", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } };
  writeStoresOff(7, ["45:drive"]);
  writeStoresOff(null, ["1:in_store"]);
  assert.deepEqual(readStoresOff(7), ["45:drive"]);
  assert.deepEqual(readStoresOff(null), ["1:in_store"]);
  assert.deepEqual(readStoresOff(8), []);
  store.set("v2:basket:stores-off:7", "{oops");
  assert.deepEqual(readStoresOff(7), []);
  globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual(readStoresOff(7), []);
  assert.doesNotThrow(() => writeStoresOff(7, ["45:drive"]));
  delete globalThis.localStorage;
});
