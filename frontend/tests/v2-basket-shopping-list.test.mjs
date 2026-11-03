import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-shopping-list.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { listSetting, listViewOf, shoppingListPath, splitList, storeChoices, storeList, withChecked } =
  await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

const keyOf = item => "kind" in item ? `${item.kind}:${item.name.toLocaleLowerCase("fr")}` : `product:${item.id}`;
const reading = (store_id, retailer, sales_channel = "in_store") => ({ store_id, retailer, sales_channel, store_name: retailer + " centre", city: "Houilles" });
const milk = { id: 1, revision: 1, data: { name: "Lait" } };
const pasta = { kind: "group", name: "Pâtes" };
const eggs = { id: 3, revision: 1, data: { name: "Œufs" } };
const rice = { kind: "group", name: "Riz" };
const choice = (item, store, cents) => ({ item, product: "kind" in item ? { id: 9, data: { name: item.name } } : item, reading: store, cents, packages: 1, usedCents: cents, used: false });
const auchan = reading(1, "Auchan"), leclerc = reading(2, "Leclerc", "drive");
const comparison = {
  stores: [
    { key: "1:in_store", reading: auchan, choices: [choice(milk, auchan, 100), choice(pasta, auchan, 150)], cents: 250, usedCents: 250, coverage: 2 },
    { key: "2:drive", reading: leclerc, choices: [choice(milk, leclerc, 90), choice(pasta, leclerc, 170), choice(eggs, leclerc, 300)], cents: 560, usedCents: 560, coverage: 3 },
  ],
  split: [], splitCents: 0, splitUsedCents: 0, missing: [rice], failed: [], truncated: [], withdrawn: 0,
};
const split = { ...comparison, split: [choice(milk, leclerc, 90), choice(pasta, auchan, 150), choice(eggs, leclerc, 300)] };
const items = [milk, pasta, eggs, rice];

test("one store's list: the whole basket there, what it has no price for first", () => {
  const list = storeList(comparison, items, "1:in_store", keyOf);
  assert.equal(list.reading.retailer, "Auchan");
  assert.deepEqual(list.missing.map(line => line.key), ["product:3", "group:riz"], "eggs and rice have no price at Auchan");
  assert.ok(list.missing.every(line => line.choice === null));
  assert.deepEqual(list.lines.map(line => [line.key, line.choice.cents]), [["product:1", 100], ["group:pâtes", 150]]);
  assert.equal(storeList(comparison, items, "7:drive", keyOf), null, "a store no longer compared");
});

test("the whole list follows the split, one section per store, the biggest share first", () => {
  const { sections, unpriced } = splitList(split, items, keyOf);
  assert.deepEqual(sections.map(section => [section.reading.retailer, section.lines.map(line => line.key), section.cents]),
    [["Leclerc", ["product:1", "product:3"], 390], ["Auchan", ["group:pâtes"], 150]]);
  assert.deepEqual(unpriced.map(line => line.key), ["group:riz"], "what no compared store prices");
});

test("ticks: on and off, once each, only for articles still in the basket", () => {
  const keys = items.map(keyOf);
  let checked = withChecked([], "product:1", true, keys);
  checked = withChecked(checked, "product:1", true, keys);
  assert.deepEqual(checked, ["product:1"]);
  assert.deepEqual(withChecked(checked, "group:riz", true, keys), ["product:1", "group:riz"]);
  assert.deepEqual(withChecked(checked, "product:1", false, keys), []);
  assert.deepEqual(withChecked(["product:99", "product:1"], "group:riz", true, keys), ["product:1", "group:riz"], "a removed article's tick goes");
  assert.deepEqual(withChecked([], "product:99", true, keys), [], "an article not in the basket is not ticked");
});

test("the list mode kept with the basket: all articles, the split, or one store", () => {
  assert.equal(shoppingListPath("/v2/panier/partage"), "/v2/panier/partage/liste");
  for (const view of [{ kind: "all" }, { kind: "stores" }, { kind: "store", key: "2:drive" }]) assert.deepEqual(listViewOf(listSetting(view)), view);
  assert.equal(listSetting({ kind: "store", key: "2:drive" }), "store:2:drive");
  assert.equal(listSetting({ kind: "stores" }), "split");
  for (const bad of [undefined, null, "", "store:", "store:0:drive", "store:2:bike", "cheapest", 3]) assert.deepEqual(listViewOf(bad), { kind: "all" }, String(bad));
});

test("one store for the whole list: compared stores only, without those switched off", () => {
  assert.deepEqual(storeChoices(comparison.stores, []).map(store => store.key), ["1:in_store", "2:drive"]);
  assert.deepEqual(storeChoices(comparison.stores, ["2:drive"]).map(store => store.key), ["1:in_store"]);
});
