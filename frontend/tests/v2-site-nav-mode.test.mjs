import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-app-mode.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { appModeKey, readAppMode, writeAppMode } = await import(
  `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

function memory() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}

test("the contribution mode is remembered per account on this device; shopping is the default", () => {
  const storage = memory();
  assert.equal(readAppMode(storage, 7), "shopping");
  writeAppMode(storage, 7, "contribute");
  assert.equal(storage.values.get(appModeKey(7)), "contribute");
  assert.equal(readAppMode(storage, 7), "contribute");
  assert.equal(readAppMode(storage, 8), "shopping");
  writeAppMode(storage, 7, "shopping");
  assert.equal(storage.values.size, 0);
});

test("a visitor always shops, and an unreadable storage falls back to shopping", () => {
  const storage = memory();
  storage.setItem(appModeKey(7), "contribute");
  assert.equal(readAppMode(storage, null), "shopping");
  assert.equal(readAppMode(null, 7), "shopping");
  assert.equal(readAppMode({ getItem() { throw new Error("blocked"); } }, 7), "shopping");
  storage.setItem(appModeKey(9), "other");
  assert.equal(readAppMode(storage, 9), "shopping");
  assert.doesNotThrow(() => writeAppMode({ setItem() { throw new Error("full"); }, removeItem() {} }, 7, "contribute"));
});
