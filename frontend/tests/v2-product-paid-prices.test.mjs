import assert from "node:assert/strict";
import { test } from "node:test";
import { Fragment, act, h, loadModule, render, settle, startDom } from "./fixtures/react-harness.mjs";

startDom();
const http = await loadModule("v2-http.ts");
const { usePaidPrices } = await loadModule("usePaidPrices.ts", {
  "./v2-basket-credits-api": await loadModule("v2-basket-credits-api.ts"),
  "./v2-price-cache": await loadModule("v2-price-cache.ts"),
  "./v2-http": http,
});

const store = new Map();
globalThis.localStorage = {
  getItem: key => store.get(key) ?? null, setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: key => { store.delete(key); },
};
// The server: a balance of 5 credits, one spent per product page of prices.
let balance = 5;
const paidRequests = [];
const credits = () => ({ balance, daily_grant: 5, hold_max: 10, next_grant_on: "2026-11-07" });
const reading = { price: "1.99", observed_at: "2026-11-05", retailer: "Enseigne", store_name: "Centre", store_id: 3, city: "Lyon", postal_code: "69001" };
globalThis.fetch = async url => {
  if (url.startsWith("/api/v2/prices/products/")) { paidRequests.push(url); balance -= 1; }
  const body = url === "/api/v2/credits" ? credits() : { latest_by_store: [reading], credits: credits() };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
};

// The shopping product page holds the same prices twice: the lowest price at the top, the history folded below.
const seen = {};
function Viewer({ name, id }) {
  seen[name] = usePaidPrices(7, "product", id, 1, () => `/api/v2/prices/products/${id}`);
  return null;
}
const page = (id, other) => h(Fragment, null, h(Viewer, { name: "top", id }), h(Viewer, { name: "fold", id }), h(Viewer, { name: "other", id: other }));

test("prices paid in the folded history also show at the top, for one credit", async () => {
  const view = await render(page("12", "13"));
  await settle();
  assert.equal(seen.top.data, null);
  await act(() => seen.fold.pay());
  await settle();
  assert.deepEqual(paidRequests, ["/api/v2/prices/products/12"]);
  assert.deepEqual(seen.top.data.latest_by_store, [reading], "the top shows what the fold paid for");
  assert.equal(seen.top.fetchedAt, seen.fold.fetchedAt);
  assert.equal(seen.top.credits.balance, 4, "and the balance left");
  assert.equal(seen.other.data, null, "another product's prices stay unpaid");
  await view.unmount();
});

test("prices paid at the top also open the folded history, for one credit", async () => {
  paidRequests.length = 0;
  const view = await render(page("20", "21"));
  await settle();
  await act(() => seen.top.pay());
  await settle();
  assert.deepEqual(paidRequests, ["/api/v2/prices/products/20"]);
  assert.deepEqual(seen.fold.data.latest_by_store, [reading]);
  assert.equal(seen.fold.newer, false);
  assert.equal(seen.other.data, null);
  await view.unmount();
  // Coming back costs nothing: the page is read from this browser, as before.
  await render(page("20", "21"));
  await settle();
  assert.deepEqual(seen.top.data.latest_by_store, [reading]);
  assert.equal(paidRequests.length, 1);
});
