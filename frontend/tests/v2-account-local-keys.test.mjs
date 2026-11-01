import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-account-local-keys.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { accountLocalKeys } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

test("an account's own drafts, edits and baskets are removed", () => {
  const own = [
    "v2:product:new:3", "v2:product:new:3:ean:3017620422003", "v2:product:edit:3:7", "v2:product:draft:3:12",
    "v2:recipe:new:3", "v2:recipe:new:3:copy", "v2:recipe:edit:3:5", "v2:recipe:proposal:3:9", "v2:basket:items:3",
  ];
  assert.deepEqual(accountLocalKeys(own, 3), own);
});

test("another account whose id starts with the same digits keeps its data", () => {
  // Matching the start of `v2:product:new:3` also took the accounts 30-39, 300-399 and so on.
  const others = [
    "v2:product:new:30", "v2:product:new:31:ean:3017620422003", "v2:product:new:300",
    "v2:recipe:new:30", "v2:recipe:new:333", "v2:product:edit:30:7", "v2:product:draft:33:12",
    "v2:recipe:edit:34:5", "v2:recipe:proposal:300:9", "v2:basket:items:13", "v2:basket:items:30",
  ];
  assert.deepEqual(accountLocalKeys(others, 3), []);
});

test("anonymous drafts and unrelated keys are left alone", () => {
  assert.deepEqual(accountLocalKeys(["v2:product:new", "v2:recipe:new", "v2:basket:active-user", "theme", "v2:product:new:"], 3), []);
});

test("the exact keys given by the caller are removed, and only those", () => {
  const keys = ["v2:pwa:versions:3", "v2:pwa:versions:30", "v2:pwa:recipes"];
  assert.deepEqual(accountLocalKeys(keys, 3, ["v2:pwa:versions:3", "v2:pwa:recipes"]), ["v2:pwa:versions:3", "v2:pwa:recipes"]);
});

test("a multi-digit id removes only its own keys", () => {
  const keys = ["v2:product:new:12", "v2:product:new:1", "v2:product:new:123", "v2:basket:items:12", "v2:basket:items:112"];
  assert.deepEqual(accountLocalKeys(keys, 12), ["v2:product:new:12", "v2:basket:items:12"]);
});
