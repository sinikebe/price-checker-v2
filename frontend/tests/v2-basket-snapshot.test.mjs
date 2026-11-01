import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const storageSource = readFileSync(new URL("../src/v2/v2-basket-storage.ts", import.meta.url), "utf8");
const source = readFileSync(new URL("../src/v2/v2-basket-snapshot.ts", import.meta.url), "utf8")
  .replace('import { basketItemKey, type BasketItem, type BasketProduct } from "./v2-basket-storage";', storageSource);
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const store = new Map();
let quota = Infinity;
globalThis.localStorage = {
  getItem: key => store.get(key) ?? null,
  setItem: (key, value) => { if (value.length > quota) throw new Error("QuotaExceededError"); store.set(key, value); },
  removeItem: key => store.delete(key),
};
const { snapshotFromFetch, snapshotView, readSnapshot, writeSnapshot, forgetSnapshot, snapshotKey }
  = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

const product = id => ({ id, revision: 1, data: { name: "Produit " + id } });
const price = (id, storeId) => ({ id, price: "1.50", observed_at: "2026-10-30", retailer: "Shop", store_name: "S" + storeId, store_id: storeId,
  city: "Paris", postal_code: "75001", sales_channel: "in_store", available: true, correction_status: null, source_provider: null });
const milk = { kind: "group", name: "Lait" };
const pasta = product(2);
const result = {
  fetched_at: "2026-11-01T10:00:00+00:00", credits: {},
  lines: [{ product_ids: [2], truncated: false }, { product_ids: [5, 6], truncated: true }],
  products: { 2: product(2), 5: product(5), 6: product(6) },
  prices: { 2: { latest_by_store: [price(1, 10)], stores_truncated: false }, 5: { latest_by_store: [price(2, 10)], stores_truncated: false } },
};
const reset = () => { store.clear(); quota = Infinity; for (const id of [1, 2]) forgetSnapshot(id); };

test("a fetch is kept per article, whether the article is included or not", () => {
  const snapshot = snapshotFromFetch(1, [pasta, milk], result);
  assert.deepEqual(Object.keys(snapshot.entries).sort(), ["group:lait", "product:2"]);
  assert.deepEqual(snapshot.entries["group:lait"], { productIds: [5, 6], truncated: true });
  assert.equal(snapshot.fetchedAt, result.fetched_at);
  assert.throws(() => snapshotFromFetch(1, [pasta], result), /inattendue/);
});

test("the view lists what the snapshot covers, what it lacks and what was cut", () => {
  const snapshot = snapshotFromFetch(1, [pasta, milk], result);
  const rice = product(9);
  const view = snapshotView(snapshot, [pasta, milk, rice]);
  assert.deepEqual(view.lines.map(line => line.candidates.map(candidate => candidate.id)), [[2], [5, 6]]);
  assert.deepEqual(view.stale, [rice]);
  assert.deepEqual(view.limited, [milk]);
  assert.equal(view.responses.get(2).latest_by_store[0].store_id, 10);
  assert.equal(view.responses.get(6), null, "a candidate without a price answer counts as failed, not as free");
  // Excluding an article is a different list of active articles: no new fetch is needed.
  assert.deepEqual(snapshotView(snapshot, [milk]).lines.length, 1);
  assert.deepEqual(snapshotView(null, [pasta]).stale, [pasta]);
});

test("a candidate missing from the products is dropped from its line", () => {
  const snapshot = snapshotFromFetch(1, [pasta, milk], { ...result, products: { 2: product(2), 5: product(5) } });
  assert.deepEqual(snapshotView(snapshot, [milk]).lines[0].candidates.map(candidate => candidate.id), [5]);
});

test("the last result is kept in the session and in the browser, per account", () => {
  reset();
  const snapshot = snapshotFromFetch(1, [pasta, milk], result);
  writeSnapshot(snapshot);
  assert.ok(store.has(snapshotKey(1)));
  assert.equal(readSnapshot(1), snapshot, "the session copy is used first");
  assert.equal(readSnapshot(2), null, "another account has none");
  // A fresh page load has no session copy: the stored one is read and checked.
  forgetSnapshot(1); store.set(snapshotKey(1), JSON.stringify(snapshot));
  assert.deepEqual(readSnapshot(1), snapshot);
  forgetSnapshot(1);
  store.set(snapshotKey(1), JSON.stringify({ ...snapshot, userId: 2 }));
  assert.equal(readSnapshot(1), null, "a snapshot of another account is refused");
  store.set(snapshotKey(1), "{not json"); assert.equal(readSnapshot(1), null);
  store.set(snapshotKey(1), JSON.stringify({ userId: 1 })); assert.equal(readSnapshot(1), null);
});

test("a result too large for the browser still works for the session", () => {
  reset();
  const snapshot = snapshotFromFetch(1, [pasta, milk], result);
  quota = 10;
  writeSnapshot(snapshot);
  assert.equal(readSnapshot(1), snapshot);
  assert.equal(store.has(snapshotKey(1)), false);
  forgetSnapshot(1);
  assert.equal(readSnapshot(1), null);
});
