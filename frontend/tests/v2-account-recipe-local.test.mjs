import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const original = read("../src/v2/v2-recipes-local.ts");
// The one runtime import, the offline key names, inlined; type imports are erased.
const source = original.replace('import { PWA_RECIPES_READY_KEY } from "../pwa/cache-keys";', read("../src/pwa/cache-keys.ts"));
assert.notEqual(source, original, "v2-recipes-local.ts imports PWA_RECIPES_READY_KEY from ../pwa/cache-keys");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { forgetLocalCopy, offlineRecipesReady, readLocalCopy, saveLocalCopy } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key), values };
}
const blocked = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };
const useStorage = storage => Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

const copy = { form: { title: "Tarte", description: "", base_servings: "4", prep_minutes: null, cook_minutes: null, steps: ["Cuire"], ingredients: [] }, revision: null, private: true };

test("the recipe being written is kept, read back and forgotten", () => {
  const storage = memoryStorage();
  useStorage(storage);
  assert.equal(saveLocalCopy("v2:recipe:new:1", copy), true);
  assert.deepEqual(readLocalCopy("v2:recipe:new:1"), copy);
  forgetLocalCopy("v2:recipe:new:1");
  assert.equal(storage.values.has("v2:recipe:new:1"), false);
  assert.equal(readLocalCopy("v2:recipe:new:1"), null);
  storage.setItem("v2:recipe:new:1", "{broken");
  assert.equal(readLocalCopy("v2:recipe:new:1"), null);
});

test("blocked storage never throws: a saved recipe is not reported as failed", () => {
  useStorage({ getItem: blocked, setItem: blocked, removeItem: blocked });
  assert.doesNotThrow(() => forgetLocalCopy("v2:recipe:new:1"));
  assert.equal(readLocalCopy("v2:recipe:new:1"), null);
  assert.equal(saveLocalCopy("v2:recipe:new:1", copy), false);
  assert.equal(offlineRecipesReady(), false);
  // Site data blocked: reading `localStorage` itself throws.
  Object.defineProperty(globalThis, "localStorage", { get: blocked, configurable: true });
  assert.doesNotThrow(() => forgetLocalCopy("v2:recipe:new:1"));
  assert.equal(offlineRecipesReady(), false);
});

test("the offline recipe list counts as complete only once its sync finished", () => {
  const storage = memoryStorage();
  useStorage(storage);
  assert.equal(offlineRecipesReady(), false);
  storage.setItem("v2:pwa:recipe-summaries-ready", "1");
  assert.equal(offlineRecipesReady(), true);
});
