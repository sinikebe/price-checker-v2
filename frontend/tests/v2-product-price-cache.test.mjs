import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-price-cache.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { MAX_PAID_BYTES, MAX_PAID_ENTRIES, readPaid, viewerKey, writePaid } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

function memoryStorage(limit = Infinity) {
  const store = new Map();
  return {
    store,
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => {
      const size = [...store.values()].reduce((sum, item) => sum + item.length, 0) - (store.get(key)?.length ?? 0);
      if (size + value.length > limit) throw new Error("QuotaExceededError");
      store.set(key, value);
    },
    removeItem: key => { store.delete(key); },
  };
}

test("prices paid for are kept per reader and page, with their date", () => {
  globalThis.localStorage = memoryStorage();
  const now = new Date("2026-11-02T10:00:00Z");
  assert.equal(viewerKey(7), "user:7");
  assert.equal(viewerKey(null), "visitor");
  assert.equal(writePaid("user:7", "product", "12", { observations: [1] }, now), true);
  assert.deepEqual(readPaid("user:7", "product", "12"), { fetchedAt: now.toISOString(), data: { observations: [1] } });
  assert.equal(readPaid("user:8", "product", "12"), null, "another account pays for its own");
  assert.equal(readPaid("visitor", "product", "12"), null);
  assert.equal(readPaid("user:7", "category", "12"), null, "another kind of page");
});

test("the oldest pages go first, and a page too big is not kept", () => {
  globalThis.localStorage = memoryStorage();
  for (let index = 0; index < MAX_PAID_ENTRIES + 5; index++) writePaid("visitor", "product", String(index), { index });
  assert.equal(readPaid("visitor", "product", "0"), null);
  assert.equal(readPaid("visitor", "product", "4"), null);
  assert.deepEqual(readPaid("visitor", "product", String(MAX_PAID_ENTRIES + 4)).data, { index: MAX_PAID_ENTRIES + 4 });
  const entries = [...localStorage.store.keys()].filter(key => key.startsWith("v2:prices:visitor:product:"));
  assert.equal(entries.length, MAX_PAID_ENTRIES);
  assert.equal(writePaid("visitor", "category", "big", { text: "x".repeat(MAX_PAID_BYTES) }), false);
  assert.equal(readPaid("visitor", "category", "big"), null);
});

test("a full or blocked storage never breaks the page, and bad entries are ignored", () => {
  globalThis.localStorage = memoryStorage(3000);
  for (let index = 0; index < 10; index++) writePaid("visitor", "product", String(index), { text: "y".repeat(400) });
  assert.ok(readPaid("visitor", "product", "9"), "room was made for the newest page");
  localStorage.setItem("v2:prices:visitor:product:bad", "{oops");
  assert.equal(readPaid("visitor", "product", "bad"), null);
  localStorage.setItem("v2:prices:visitor:product:old", JSON.stringify({ fetchedAt: "never", data: {} }));
  assert.equal(readPaid("visitor", "product", "old"), null);
  globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(readPaid("visitor", "product", "1"), null);
  assert.equal(writePaid("visitor", "product", "1", { a: 1 }), false);
  delete globalThis.localStorage;
});
