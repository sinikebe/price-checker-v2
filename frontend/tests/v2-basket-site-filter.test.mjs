import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read = name => readFileSync(new URL(`../src/v2/${name}`, import.meta.url), "utf8");
const load = source => import("data:text/javascript;base64," + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString("base64"));
const comparison = read("v2-basket-comparison.ts").replace(/import \{[^}]*\} from "\.\/v2-basket-quantity";/, read("v2-basket-quantity.ts"));
const site = await load(read("v2-site-filter.ts").replace(/import \{[^}]*\} from "\.\/v2-basket-comparison";/, comparison));
const { bestPrices } = await load(read("v2-product-best-price.ts"));

function memory() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
const reading = (store_id, extra = {}) => ({ store_id, city: "Lyon", postal_code: "69003", online: false, ...extra });

test("the site filter is kept per account on this device, checked, and off by default", () => {
  const storage = memory();
  assert.deepEqual(site.readSiteFilter(storage, 7), site.EMPTY_SITE_FILTER);
  const saved = site.writeSiteFilter(storage, 7, { enabled: true, stores: [{ id: 3, label: "Shop" }, { id: 3, label: "Shop" }, { id: -1, label: "x" }],
    cities: ["Lyon", "lyon", ""], departments: ["69", "2A", "999x"] });
  assert.deepEqual(saved, { enabled: true, stores: [{ id: 3, label: "Shop" }], cities: ["Lyon"], departments: ["69", "2A"] });
  assert.deepEqual(site.readSiteFilter(storage, 7), saved);
  assert.deepEqual(site.readSiteFilter(storage, 8), site.EMPTY_SITE_FILTER);
  assert.deepEqual(site.readSiteFilter(null, 7), site.EMPTY_SITE_FILTER);
  storage.setItem(site.siteFilterKey(9), "not json");
  assert.deepEqual(site.readSiteFilter(storage, 9), site.EMPTY_SITE_FILTER);
  site.writeSiteFilter(storage, 7, site.EMPTY_SITE_FILTER);
  assert.equal(storage.values.has(site.siteFilterKey(7)), false, "an empty, off filter is stored as nothing");
});

test("only an enabled filter with a criterion is in force, and it keeps the readings of its stores", () => {
  assert.equal(site.activeSiteFilters({ enabled: false, stores: [{ id: 3, label: "Shop" }], cities: [], departments: [] }), null);
  assert.equal(site.activeSiteFilters({ enabled: true, stores: [], cities: [], departments: [] }), null);
  const active = site.activeSiteFilters({ enabled: true, stores: [], cities: [], departments: ["78"] });
  assert.deepEqual(active, { storeIds: [], cities: [], departments: ["78"] });
  assert.equal(site.passesSiteFilter(reading(1, { postal_code: "78100", city: "Saint-Germain" }), active), true);
  assert.equal(site.passesSiteFilter(reading(2), active), false);
  assert.equal(site.passesSiteFilter(reading(4, { online: true, city: null, postal_code: null }), active), true, "online platforms deliver everywhere");
  assert.equal(site.passesSiteFilter(reading(2), null), true);
  assert.equal(site.siteFilterSummary({ enabled: true, stores: [{ id: 1, label: "a" }, { id: 2, label: "b" }], cities: ["Lyon"], departments: ["69", "78"] }),
    "2 magasins · 1 commune · départements 69, 78");
});

test("a group page's lowest price per product counts only the latest reading of each store", () => {
  const row = (id, product_id, store_id, price, observed_at) => ({ id, product_id, store_id, price, observed_at, retailer: "R" + store_id, store_name: "S", city: "Lyon", postal_code: "69003", sales_channel: "in_store" });
  const prices = bestPrices([row(1, 10, 1, "1.00", "2026-10-01"), row(2, 10, 1, "2.00", "2026-11-01"), row(3, 10, 2, "1.50", "2026-10-15"), row(4, 11, 1, "3.00", "2026-11-02")]);
  assert.equal(prices.get(10).cents, 150, "the old 1,00 € at store 1 no longer counts");
  assert.equal(prices.get(10).stores, 2);
  assert.equal(prices.get(11).cents, 300);
  assert.equal(prices.has(12), false);
});
