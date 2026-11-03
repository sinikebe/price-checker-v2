import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-account-local-keys.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { accountLocalKeys, logoutLocalKeys, unsentAtLogout } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

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

test("prices paid for by an account go with it, not those of another account or of visitors", async () => {
  const keys = ["v2:prices:user:3:product:12", "v2:prices:user:3:index", "v2:prices:user:30:product:1", "v2:prices:visitor:product:1"];
  assert.deepEqual(accountLocalKeys(keys, 3), ["v2:prices:user:3:product:12", "v2:prices:user:3:index"]);
});

test("signing out removes the account's shared basket copies and drafts, not its personal basket", () => {
  const keys = [
    "v2:basket:user:5", "v2:basket:prices:5", "v2:basket:stores-off:5", "v2:basket:checked:5",
    "v2:basket:shared:5", "v2:basket:shared-state:9:5", "v2:basket:shared-queue:9:5", "v2:basket:shared-prices:9:5",
    "v2:recipe:new:5", "v2:recipe:edit:5:12", "v2:recipe:proposal:5:3", "v2:product:new:5", "v2:product:edit:5:7", "v2:product:draft:5:2",
    // Other accounts on the same browser keep theirs.
    "v2:basket:shared-state:9:50", "v2:basket:shared-queue:9:15", "v2:recipe:new:50", "v2:product:edit:51:7",
  ];
  assert.deepEqual(logoutLocalKeys(keys, 5).sort(), [
    "v2:basket:shared-prices:9:5", "v2:basket:shared-queue:9:5", "v2:basket:shared-state:9:5", "v2:basket:shared:5",
    "v2:product:draft:5:2", "v2:product:edit:5:7", "v2:product:new:5",
    "v2:recipe:edit:5:12", "v2:recipe:new:5", "v2:recipe:proposal:5:3",
  ]);
});

test("what signing out would erase without it ever being sent", () => {
  const data = new Map([
    ["v2:basket:shared-queue:9:5", JSON.stringify([{ op: "add" }, { op: "settings" }])],
    ["v2:basket:shared-queue:8:5", "{oops"],
    ["v2:recipe:new:5", "{}"], ["v2:product:edit:5:7", "{}"],
    ["v2:basket:user:5", "[]"], ["v2:basket:shared-queue:9:6", JSON.stringify([{ op: "add" }])],
  ]);
  const keys = [...data.keys()];
  const storage = { length: keys.length, key: index => keys[index] ?? null, getItem: key => data.get(key) ?? null };
  assert.deepEqual(unsentAtLogout(storage, 5), { changes: 2, drafts: 2 });
  assert.deepEqual(unsentAtLogout(storage, 7), { changes: 0, drafts: 0 });
});


test("the account kept for offline use goes with the account, at sign-out and at deletion", () => {
  const keys = ["v2:auth:offline-user:7", "v2:auth:offline-user:70", "v2:basket:user:7"];
  assert.deepEqual(logoutLocalKeys(keys, 7), ["v2:auth:offline-user:7"]);
  assert.ok(accountLocalKeys(keys, 7).includes("v2:auth:offline-user:7") && !accountLocalKeys(keys, 7).includes("v2:auth:offline-user:70"));
});
