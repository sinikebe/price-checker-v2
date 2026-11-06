import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read = name => readFileSync(new URL(`../src/v2/${name}`, import.meta.url), "utf8");
const load = source => import("data:text/javascript;base64," + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString("base64"));
// Each module is loaded on its own, with the one value import it needs written in.
const storage = read("v2-basket-storage.ts");
const withStorage = name => read(name).replace(/import \{[^}]*\} from "\.\/v2-basket-storage";/, storage);
const demo = await load(withStorage("v2-basket-demo.ts"));
const { basketItemKey } = await load(storage);
const { snapshotView } = await load(withStorage("v2-basket-snapshot.ts"));
const { buildBasketComparison, splitSavings, readingKey } = await load(read("v2-basket-comparison.ts")
  .replace(/import \{[^}]*\} from "\.\/v2-basket-quantity";/, read("v2-basket-quantity.ts")));
const { splitList } = await load(read("v2-shopping-list.ts"));

const today = new Date(2026, 10, 3);
const source = demo.builtinDemo(today);
const items = demo.demoItems(demo.initialDemoState(source), source);
const view = snapshotView(source.snapshot, items);
const compare = (options = {}) => buildBasketComparison(view.lines, view.responses, options.filters, options.advanced ?? true,
  new Set(options.off ?? []), options.mode ?? "price", options.units);
const storesOf = comparison => new Set(comparison.split.map(choice => readingKey(choice.reading)));
const total = cents => (cents / 100).toFixed(2);

test("the app's example: a month of groceries with fictional prices, dated from today", () => {
  assert.equal(items.length, 18);
  assert.ok(source.fictional && source.settings.advanced, "it opens with the quantities of the month");
  assert.equal(source.savedAt, null, "the app's example was never saved");
  assert.equal(view.lines.length, 18, "the snapshot knows every article, under the basket's own keys");
  assert.deepEqual(view.stale, []);
  assert.ok(items.every(item => item.quantity), "every article has its quantity");
  const rows = [...view.responses.values()].flatMap(response => response.latest_by_store);
  assert.ok(rows.every(row => row.store_id > 9000 && row.available && row.observed_at <= "2026-11-03"));
  const ages = rows.map(row => Math.round((today - new Date(row.observed_at + "T00:00:00")) / 86400000));
  assert.ok(ages.some(age => age <= 30) && ages.some(age => age > 30 && age <= 90) && ages.some(age => age > 90), "fresh, aging and old prices");
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
});

test("the home page story holds: a cheapest store, a cheaper split, and the store left aside saves the least", () => {
  const all = compare();
  const best = all.stores.find(store => store.coverage === items.length);
  assert.equal(`${best.reading.retailer} ${best.reading.sales_channel}`, "Horizon drive");
  assert.ok(all.stores.some(store => store.coverage < items.length), "some stores only have part of the basket");
  assert.ok(all.splitCents < best.cents, `split ${total(all.splitCents)} < ${total(best.cents)}`);
  const savings = splitSavings(view.lines, view.responses, undefined, true, all);
  const weakest = [...savings].sort((a, b) => a[1].extraCents - b[1].extraCents)[0];
  assert.equal(weakest[0], demo.DEMO_STORE_OFF);
  assert.ok(weakest[1].extraCents > 0 && weakest[1].unpriced === 0);
  const final = compare({ off: [demo.DEMO_STORE_OFF] });
  assert.ok(final.splitCents < best.cents && final.split.length === items.length, "every article still has a price");
  assert.ok(final.splitCents > 9000 && final.splitCents < 10000, `a month of groceries, just under 100 €: ${total(final.splitCents)}`);
  assert.ok((best.cents - final.splitCents) / best.cents > 0.1, "more than 10 % saved");
  assert.equal(storesOf(final).size, storesOf(all).size - 1);
  assert.equal(final.splitCents - all.splitCents, weakest[1].extraCents, "what the store saved is what leaving it costs");
  const list = splitList(final, items, basketItemKey);
  assert.equal(list.unpriced.length, 0);
  assert.equal(list.sections[0].reading.retailer, "Cabas Discount");
});

test("every setting changes something in the demo", () => {
  const price = compare({ off: [demo.DEMO_STORE_OFF] });
  const unit = compare({ off: [demo.DEMO_STORE_OFF], mode: "unit" });
  const choice = (comparison, name) => comparison.split.find(entry => entry.item.name === name);
  for (const name of ["Pâtes", "Riz basmati"]) {
    assert.equal(choice(price, name).product.data.quantity, "500 g", name);
    assert.equal(choice(unit, name).product.data.quantity, "1 kg", `per kilogram the bigger pack wins, with some left over: ${name}`);
    assert.ok(choice(unit, name).unit.surplus > 0);
  }
  assert.deepEqual(choice(unit, "Pommes").unit.available, ["g", "piece"], "apples can be compared per kilogram or per piece");
  const simple = compare({ off: [demo.DEMO_STORE_OFF], advanced: false });
  assert.ok(simple.splitCents < price.splitCents, "one pack per article without the quantities");
  assert.equal(price.split.find(entry => entry.item.data?.name === "Lait demi-écrémé").packages, 8);
  const rows = [...view.responses.values()].flatMap(response => response.latest_by_store);
  assert.deepEqual([...new Set(rows.map(row => row.postal_code.slice(0, 2)))].sort(), ["01", "69"]);
  assert.ok(new Set(rows.map(row => row.city)).size >= 3);
  const rhone = compare({ filters: { storeIds: [], cities: [], departments: ["69"] } });
  assert.ok(![...storesOf(rhone)].some(key => key.startsWith("9104:")), "the department filter leaves the store of the Ain out");
  assert.ok(rhone.splitCents > compare().splitCents);
});

test("the demo state read back from the tab: changes kept, anything else back to the start", () => {
  const start = demo.initialDemoState(source);
  assert.deepEqual(start.settings.stores_off, [demo.DEMO_STORE_OFF]);
  for (const bad of [null, 3, "x", [], { lines: "x", settings: 4 }, { ...start, source: "saved:other" }])
    assert.deepEqual(demo.normalizeDemoState(bad, source), start, "another demo, or anything unexpected, starts again");
  const [pasta, milk] = start.lines;
  const state = demo.normalizeDemoState({
    source: "builtin",
    lines: [{ ...milk, disabled: true, quantity: { amount: "-1", unit: "kg" } }, pasta, pasta, { key: "product:1", disabled: false, quantity: null }],
    settings: {
      advanced: false, compare: "unit", stores_off: ["9101:drive", "bad", 7], units: { "group:pommes": "piece", x: "km" },
      filters: { storeIds: [9101, -1, "2"], cities: ["Lyon", ""], departments: ["69", "toolong"] }, checked: ["group:pâtes", 5], list_mode: "store:9101:drive",
    },
  }, source);
  assert.deepEqual(state.lines.map(line => [line.key, line.disabled, line.quantity]), [[milk.key, true, null], [pasta.key, false, pasta.quantity]],
    "unknown or repeated lines dropped, a bad quantity forgotten");
  assert.deepEqual(state.settings, {
    advanced: false, compare: "unit", stores_off: ["9101:drive"], units: { "group:pommes": "piece" },
    filters: { storeIds: [9101], cities: ["Lyon"], departments: ["69"] }, checked: ["group:pâtes"], list_mode: "store:9101:drive",
  });
  assert.deepEqual(demo.normalizeDemoState({ source: "builtin", lines: [], settings: {} }, source).lines, [], "an emptied demo stays empty until it starts again");
  const shown = demo.demoItems(state, source);
  assert.equal(shown[0].disabled, true);
  assert.equal(shown[0].quantity, undefined);
  assert.deepEqual(shown[1].quantity, { amount: "1.5", unit: "kg" });
});

test("a demo saved by an administrator is read as the server sends it, and refused when it does not hold together", () => {
  const product = { id: 41, revision: 2, data: { name: "Lait", brand: "Ferme", quantity: "1 L" }, quantity: { amount: "6", unit: "package" } };
  const group = { kind: "group", name: "Pâtes", disabled: true };
  const reading = { id: 1, price: "1.10", observed_at: "2026-11-01", retailer: "Réel", store_name: "Réel Nord", store_id: 3, city: "Lyon",
    postal_code: "69003", sales_channel: "in_store", available: true, correction_status: null, source_provider: null };
  const sent = {
    title: "Un vrai mois", saved_at: "2026-11-03T10:00:00+00:00",
    content: {
      items: [product, group],
      settings: { advanced: true, compare: "price", stores_off: [], units: {}, checked: ["group:pâtes"], list_mode: "split", filters: { storeIds: [3] } },
      result: { fetched_at: "2026-11-03T10:00:00+00:00", lines: [{ product_ids: [41], truncated: false }, { product_ids: [52, 53], truncated: true }],
        products: { 41: product }, prices: { 41: { latest_by_store: [reading], stores_truncated: false } } },
    },
  };
  const saved = demo.savedDemo(sent);
  assert.equal(saved.fictional, false);
  assert.equal(saved.savedAt, "2026-11-03T10:00:00+00:00", "a saved demo always says when it was saved");
  assert.equal(demo.demoDate(saved.savedAt), "3 novembre 2026");
  assert.equal(saved.id, "saved:2026-11-03T10:00:00+00:00", "a new save starts the demo again for everyone");
  assert.deepEqual(saved.snapshot.entries, { "product:41": { productIds: [41], truncated: false }, "group:pâtes": { productIds: [52, 53], truncated: true } });
  assert.deepEqual(saved.settings.checked, [], "the ticks are the visitor's own");
  assert.deepEqual(saved.settings.filters, { storeIds: [3], cities: [], departments: [] });
  assert.equal(demo.demoItems(demo.initialDemoState(saved), saved)[1].disabled, true, "an article excluded in the saved basket starts excluded");
  for (const broken of [null, {}, { ...sent, title: "" }, { ...sent, content: { ...sent.content, items: [product] } },
    { ...sent, content: { ...sent.content, items: [product, { kind: "group" }] } },
    { ...sent, content: { ...sent.content, items: [product, product], result: { ...sent.content.result } } }])
    assert.equal(demo.savedDemo(broken), null);
});
