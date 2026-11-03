import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-offline-user.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { offlineUser, offlineUserKey, rememberOfflineUser } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

test("offline, the app knows the account last signed in on this browser, and only that one", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
  assert.equal(offlineUser(7), null);
  rememberOfflineUser({ id: 7, username: "ana", role: "confirmed", extra: "not kept" });
  assert.deepEqual(JSON.parse(store.get(offlineUserKey(7))), { id: 7, username: "ana", role: "confirmed" });
  assert.deepEqual(offlineUser(7), { id: 7, username: "ana", role: "confirmed" });
  assert.equal(offlineUser(null), null, "no account active on this browser: signed out");
  assert.equal(offlineUser(8), null, "another account's basket is never shown under this one");
  store.set(offlineUserKey(8), JSON.stringify({ id: 9, username: "x", role: "admin" }));
  assert.equal(offlineUser(8), null, "a copy that does not match its key is ignored");
  store.set(offlineUserKey(8), "{broken");
  assert.equal(offlineUser(8), null);
  delete globalThis.localStorage;
});
