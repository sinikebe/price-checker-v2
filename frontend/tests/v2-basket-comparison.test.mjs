import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const quantitySource = readFileSync(new URL("../src/v2/v2-basket-quantity.ts", import.meta.url), "utf8");
const source = readFileSync(new URL("../src/v2/v2-basket-comparison.ts", import.meta.url), "utf8")
  .replace('import { baseQuantity, microUnits, pricedQuantity, productSize, purchaseDemand, type BaseUnit } from "./v2-basket-quantity";', quantitySource);
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { buildBasketComparison, postalDepartment, pricePosition, splitSavings, readingKey } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

const product = id => ({ id, revision: 1, data: { name: "Product " + id } });
const line = (item, ...candidates) => ({ item, candidates });
const reading = (id, storeId, price, extra = {}) => ({
  id, price, observed_at: "2026-10-20", retailer: "Shop", store_name: "Store " + storeId,
  store_id: storeId, city: "Paris", postal_code: "75001", sales_channel: "in_store",
  available: true, correction_status: null, source_provider: null, ...extra,
});
const response = (...rows) => ({ latest_by_store: rows, stores_truncated: false });

test("a store total is complete only with all articles; split uses eligible readings", () => {
  const products = [product(1), product(2), product(3)];
  const results = new Map([
    [1, response(reading(1, 10, "2.50"), reading(2, 20, "1.75"))],
    [2, response(reading(3, 10, "3.00"), reading(4, 20, "0.99", { available: false }),
      reading(5, 30, "2.10"))],
    [3, response(reading(6, 10, "1.25"), reading(7, 30, "0.50", { correction_status: "active" }))],
  ]);
  const comparison = buildBasketComparison(products.map(item => line(item, item)), results);
  assert.equal(comparison.stores[0].key, "10:in_store");
  assert.equal(comparison.stores[0].coverage, 3);
  assert.equal(comparison.stores[0].cents, 675);
  assert.equal(comparison.stores.find(store => store.key === "20:in_store").coverage, 1);
  assert.equal(comparison.splitCents, 510);
  assert.deepEqual(comparison.split.map(choice => choice.reading.id), [2, 5, 6]);
  assert.deepEqual(comparison.missing, []);
});

test("group and ensemble each count once and select one product per store", () => {
  const group = { kind: "group", name: "Jus d'orange" };
  const scope = { kind: "scope", name: "Jus", department: "Boissons", family: "Jus de fruits" };
  const products = [product(1), product(2), product(3)];
  const comparison = buildBasketComparison([
    line(group, products[0], products[1]), line(scope, products[1], products[2]),
  ], new Map([
    [1, response(reading(1, 10, "2.50"), reading(2, 20, "2.00"))],
    [2, response(reading(3, 10, "1.80"), reading(4, 20, "1.90"))],
    [3, response(reading(5, 10, "3.00"), reading(6, 20, "1.50"))],
  ]));
  assert.equal(comparison.stores.find(store => store.key === "10:in_store").cents, 360);
  assert.deepEqual(comparison.stores.find(store => store.key === "10:in_store").choices.map(choice => choice.product.id), [2, 2]);
  assert.equal(comparison.splitCents, 330);
  assert.deepEqual(comparison.split.map(choice => choice.product.id), [2, 3]);
});

test("filters allow several stores, cities or departments and limit both comparison views", () => {
  const item = product(1);
  const results = new Map([[1, response(
    reading(1, 10, "2.00", { city: "Paris", postal_code: "75001" }),
    reading(2, 20, "1.00", { city: "Lyon", postal_code: "69001" }),
    reading(3, 30, "0.50", { city: "Marseille", postal_code: "13001" }),
  )]]);
  const comparison = buildBasketComparison([line(item, item)], results, {
    storeIds: [10, 20], cities: ["Paris", "Lyon"], departments: ["75", "69"],
  });
  assert.deepEqual(comparison.stores.map(store => store.key), ["20:in_store", "10:in_store"]);
  assert.equal(comparison.splitCents, 100);
  assert.equal(buildBasketComparison([line(item, item)], results, {
    storeIds: [], cities: [], departments: ["13"],
  }).splitCents, 50);
});

test("failed candidates do not yield a misleading minimum for a group", () => {
  const group = { kind: "group", name: "Beans" };
  const comparison = buildBasketComparison([line(group, product(1), product(2))], new Map([
    [1, response(reading(1, 10, "1.00"))], [2, null],
  ]));
  assert.deepEqual(comparison.failed, [group]);
  assert.equal(comparison.stores.length, 0);
});

test("missing and failed products never produce a complete total", () => {
  const products = [product(1), product(2), product(3)];
  const comparison = buildBasketComparison(products.map(item => line(item, item)), new Map([
    [1, response(reading(1, 10, "2.00"))],
    [2, response(reading(2, 10, "0.99", { available: false }))],
    [3, null],
  ]));
  assert.equal(comparison.splitCents, 200);
  assert.equal(comparison.stores[0].coverage, 1);
  assert.deepEqual(comparison.missing.map(item => item.id), [2, 3]);
  assert.deepEqual(comparison.failed.map(item => item.id), [3]);
});

test("ties prefer newer readings, while store and drive remain separate", () => {
  const item = product(1);
  const comparison = buildBasketComparison([line(item, item)], new Map([
    [1, response(reading(1, 10, "1.50", { observed_at: "2026-10-01" }),
      reading(2, 10, "1.50", { observed_at: "2026-10-24", sales_channel: "drive" }))],
  ]));
  assert.equal(comparison.split[0].reading.id, 2);
  assert.deepEqual(new Set(comparison.stores.map(store => store.key)), new Set(["10:drive", "10:in_store"]));
});

test("department extraction handles mainland, Corsica and overseas postal codes", () => {
  assert.deepEqual(["75001", "20190", "20200", "97100", "97410", "abc"].map(postalDepartment),
    ["75", "2A", "2B", "971", "974", null]);
});


test("price position is relative to comparable result range", () => {
  assert.equal(pricePosition(100, 100, 100), "neutral");
  assert.equal(pricePosition(100, 100, 400), "low");
  assert.equal(pricePosition(250, 100, 400), "middle");
  assert.equal(pricePosition(400, 100, 500), "high");
});

test("advanced basket buys whole packs while showing the used share", () => {
  const butter = { ...product(1), data: { name: "Beurre", quantity_amount: "250", quantity_unit: "g" } };
  const item = { ...butter, quantity: { amount: "20", unit: "g" } };
  const result = buildBasketComparison([line(item, butter)], new Map([[1, response(reading(1, 10, "2.50"))]]), undefined, true);
  assert.equal(result.splitCents, 250);
  assert.equal(result.splitUsedCents, 20);
  assert.equal(result.split[0].packages, 1);
  const many = buildBasketComparison([line({ ...item, quantity: { amount: "600", unit: "g" } }, butter)],
    new Map([[1, response(reading(1, 10, "2.50"))]]), undefined, true);
  assert.equal(many.splitCents, 750);
  assert.equal(many.splitUsedCents, 600);
  assert.equal(many.split[0].packages, 3);
});

test("advanced comparison excludes incompatible or unknown package sizes", () => {
  const item = { kind: "group", name: "Beurre", quantity: { amount: "20", unit: "g" } };
  const unknown = product(1);
  const butter = { ...product(2), data: { name: "Beurre", quantity_amount: "250", quantity_unit: "g" } };
  const result = buildBasketComparison([line(item, unknown, butter)], new Map([
    [1, response(reading(1, 10, "1.00"))], [2, response(reading(2, 10, "2.50"))],
  ]), undefined, true);
  assert.equal(result.split[0].product.id, 2);
  assert.equal(result.splitCents, 250);
});

test("advanced totals share a purchased pack across product and group lines", () => {
  const butter = { ...product(1), data: { name: "Beurre", quantity_amount: "250.000", quantity_unit: "g" } };
  const exact = { ...butter, quantity: { amount: "20", unit: "g" } };
  const group = { kind: "group", name: "Beurre", quantity: { amount: "20", unit: "g" } };
  const result = buildBasketComparison([line(exact, butter), line(group, butter)],
    new Map([[1, response(reading(1, 10, "2.50"), reading(2, 20, "3.00"))]]), undefined, true);
  assert.equal(result.stores.find(store => store.key === "10:in_store").cents, 250);
  assert.equal(result.splitCents, 250);
  assert.equal(result.splitUsedCents, 40);
  assert.equal(result.stores.find(store => store.key === "20:in_store").cents, 300);
});

test("shared packs use exact aggregate ceilings across physical and package requests", () => {
  const butter = { ...product(1), data: { name: "Beurre", quantity_amount: "250.000", quantity_unit: "g" } };
  const result = buildBasketComparison([
    line({ ...butter, quantity: { amount: "125", unit: "g" } }, butter),
    line({ kind: "group", name: "Beurre", quantity: { amount: "0.5", unit: "package" } }, butter),
  ], new Map([[1, response(reading(1, 10, "2.50"))]]), undefined, true);
  assert.equal(result.splitCents, 250);
  assert.equal(result.splitUsedCents, 250);
});

// Three articles and three stores: each article is cheapest in a different store.
function threeStores() {
  const items = [1, 2, 3].map(id => ({ id, revision: 1, data: { name: "Article " + id } }));
  const lines = items.map(item => line(item, product(item.id)));
  const prices = { 1: { 10: "1.00", 20: "2.00", 30: "1.50" }, 2: { 10: "5.00", 20: "4.00", 30: "4.50" }, 3: { 10: "3.00", 20: "3.50", 30: "2.00" } };
  const responses = new Map(Object.entries(prices).map(([id, byStore]) => [Number(id),
    response(...Object.entries(byStore).map(([store, price]) => reading(Number(id) * 100 + Number(store), Number(store), price)))]));
  return { items, lines, responses };
}
const savings = (lines, responses, filters = { storeIds: [], cities: [], departments: [] }, advanced = false) =>
  splitSavings(lines, responses, filters, advanced, buildBasketComparison(lines, responses, filters, advanced));

test("each store of the split shows how much more the basket costs without it", () => {
  const { lines, responses } = threeStores();
  const comparison = buildBasketComparison(lines, responses);
  assert.equal(comparison.splitCents, 700, "1.00 + 4.00 + 2.00");
  const result = savings(lines, responses);
  assert.deepEqual([...result.keys()].sort(), ["10:in_store", "20:in_store", "30:in_store"]);
  // Without store 10, article 1 costs 1.50 elsewhere; without 20, article 2 costs 4.50; without 30, article 3 costs 3.00.
  assert.deepEqual(result.get("10:in_store"), { extraCents: 50, unpriced: 0 });
  assert.deepEqual(result.get("20:in_store"), { extraCents: 50, unpriced: 0 });
  assert.deepEqual(result.get("30:in_store"), { extraCents: 100, unpriced: 0 });
});

test("the same price in another store means no saving", () => {
  const { lines, responses } = threeStores();
  responses.get(1).latest_by_store.find(row => row.store_id === 30).price = "1.00";
  assert.deepEqual(savings(lines, responses).get("10:in_store"), { extraCents: 0, unpriced: 0 });
});

test("an article that only one store prices is reported, and left out of the comparison", () => {
  const { items, lines, responses } = threeStores();
  const only = { id: 4, revision: 1, data: { name: "Introuvable ailleurs" } };
  lines.push(line(only, product(4)));
  responses.set(4, response(reading(410, 10, "1.20")));
  const result = savings(lines, responses);
  assert.deepEqual(result.get("10:in_store"), { extraCents: 50, unpriced: 1 }, "article 1 moves to store 30; article 4 has no other price");
  assert.deepEqual(result.get("20:in_store"), { extraCents: 50, unpriced: 0 });
  assert.equal(items.length, 3);
});

test("a single store has no alternative at all", () => {
  const item = { id: 1, revision: 1, data: { name: "Seul" } };
  const lines = [line(item, product(1))], responses = new Map([[1, response(reading(1, 10, "2.00"))]]);
  assert.deepEqual(savings(lines, responses).get("10:in_store"), { extraCents: 0, unpriced: 1 });
});

test("the alternatives are the stores that pass the filters", () => {
  const { lines, responses } = threeStores();
  const result = savings(lines, responses, { storeIds: [10, 20], cities: [], departments: [] });
  assert.deepEqual([...result.keys()].sort(), ["10:in_store", "20:in_store"], "store 30 is not compared at all");
  // Articles 1 and 3 are cheapest at store 10: they fall back to 2.00 and 3.50 at store 20, never to store 30's 1.50 and 2.00.
  assert.deepEqual(result.get("10:in_store"), { extraCents: 150, unpriced: 0 });
});

test("the same store with another sales channel is another alternative", () => {
  const item = { id: 1, revision: 1, data: { name: "Lait" } };
  const lines = [line(item, product(1))];
  const responses = new Map([[1, response(reading(1, 10, "1.00", { sales_channel: "drive" }), reading(2, 10, "1.40"), reading(3, 20, "1.60"))]]);
  const result = savings(lines, responses);
  assert.equal(readingKey(responses.get(1).latest_by_store[0]), "10:drive");
  assert.deepEqual(result.get("10:drive"), { extraCents: 40, unpriced: 0 }, "the in-store price of the same store takes over");
});

test("advanced quantities and whole packs are priced the same way with and without the store", () => {
  const pack = id => ({ id, revision: 1, data: { name: "Riz", quantity_amount: "500", quantity_unit: "g" } });
  const item = { id: 1, revision: 1, data: { name: "Riz" }, quantity: { amount: "1", unit: "kg" } };
  const lines = [line(item, pack(1))];
  const responses = new Map([[1, response(reading(1, 10, "1.00"), reading(2, 20, "1.20"))]]);
  const comparison = buildBasketComparison(lines, responses, undefined, true);
  assert.equal(comparison.splitCents, 200, "two packs of 500 g at 1.00");
  assert.deepEqual(savings(lines, responses, undefined, true).get("10:in_store"), { extraCents: 40, unpriced: 0 }, "two packs at 1.20");
});

test("the baseline comparison is unchanged by the exclusion argument", () => {
  const { lines, responses } = threeStores();
  const plain = buildBasketComparison(lines, responses);
  const same = buildBasketComparison(lines, responses, undefined, false, new Set());
  assert.equal(plain.splitCents, same.splitCents);
  assert.equal(buildBasketComparison(lines, responses, undefined, false, new Set(["10:in_store"])).split.find(choice => choice.item === lines[0].item).reading.store_id, 30);
});

// Per-unit mode: the product with the best price per kg, L or piece is chosen, even in a bigger pack.
const sized = (id, amount, unit, name = "Produit " + id) => ({ id, revision: 1, data: { name, quantity_amount: String(amount), quantity_unit: unit } });
const group = (name, quantity) => ({ kind: "group", name, ...(quantity ? { quantity } : {}) });
const compare = (lines, responses, mode, advanced = false, filters = { storeIds: [], cities: [], departments: [] }) =>
  buildBasketComparison(lines, responses, filters, advanced, new Set(), mode);

function flour() {
  const small = sized(1, 500, "g"), big = sized(2, 1000, "g");
  const item = group("Farine", { amount: "500", unit: "g" });
  const responses = new Map([[1, response(reading(11, 10, "1.50"), reading(13, 20, "1.50"))], [2, response(reading(12, 10, "2.40"))]]);
  return { small, big, item, lines: [line(item, small, big)], responses };
}

test("per unit, a bigger pack wins on the price per kg, and the cash to pay and the surplus are shown", () => {
  const { lines, responses, big, small } = flour();
  const byPrice = compare(lines, responses, "price", true);
  assert.equal(byPrice.split[0].product.id, small.id, "by price: the 500 g pack for 1.50");
  assert.equal(byPrice.splitCents, 150);
  const byUnit = compare(lines, responses, "unit", true);
  const choice = byUnit.split[0];
  assert.equal(choice.product.id, big.id, "per unit: 2.40 per kg beats 3.00 per kg");
  assert.equal(byUnit.splitCents, 240, "the cash to pay is the whole kilo");
  assert.equal(byUnit.splitUsedCents, 120, "the 500 g needed are worth 1.20");
  assert.equal(choice.unit.perUnitCents * 1000, 240);
  assert.deepEqual([choice.unit.unit, choice.unit.surplus, choice.packages, choice.used], ["g", 500, 1, true]);
});

test("without a quantity, one smallest pack is the need and the better-value big pack leaves the rest", () => {
  const one = sized(1, 1000, "ml"), six = sized(2, 6000, "ml");
  const lines = [line(group("Lait"), one, six)];
  const responses = new Map([[1, response(reading(1, 10, "1.10"))], [2, response(reading(2, 10, "5.40"))]]);
  assert.equal(compare(lines, responses, "price").split[0].product.id, 1);
  const byUnit = compare(lines, responses, "unit");
  assert.equal(byUnit.split[0].product.id, 2);
  assert.deepEqual([byUnit.splitCents, byUnit.splitUsedCents, byUnit.split[0].unit.surplus], [540, 90, 5000]);
});

test("a single product is chosen the same way in both modes", () => {
  const rice = sized(1, 500, "g");
  const item = { id: 1, revision: 1, data: rice.data };
  const lines = [line(item, rice)];
  const responses = new Map([[1, response(reading(1, 10, "1.20"), reading(2, 20, "1.00"))]]);
  const price = compare(lines, responses, "price"), unit = compare(lines, responses, "unit");
  assert.equal(price.split[0].reading.store_id, unit.split[0].reading.store_id);
  assert.equal(price.splitCents, unit.splitCents);
  assert.equal(unit.split[0].unit.surplus, 0);
  assert.equal(unit.split[0].used, false, "nothing is left over");
});

test("per unit, stores are ranked on the value of what is needed, not on the cash to pay", () => {
  const small = sized(1, 500, "g"), big = sized(2, 1000, "g");
  const item = group("Farine", { amount: "500", unit: "g" });
  const lines = [line(item, small, big)];
  const responses = new Map([[1, response(reading(1, 20, "1.50"))], [2, response(reading(2, 10, "2.40"))]]);
  assert.deepEqual(compare(lines, responses, "price", true).stores.map(store => store.reading.store_id), [20, 10], "least to pay first");
  const unit = compare(lines, responses, "unit", true);
  assert.deepEqual(unit.stores.map(store => store.reading.store_id), [10, 20], "best value first");
  assert.deepEqual(unit.stores.map(store => [store.cents, store.usedCents]), [[240, 120], [150, 150]]);
});

test("a line whose products have no known size is compared on the pack price in both modes", () => {
  const lines = [line(group("Divers"), product(1), product(2))];
  const responses = new Map([[1, response(reading(1, 10, "3.00"))], [2, response(reading(2, 10, "2.00"))]]);
  const unit = compare(lines, responses, "unit");
  assert.equal(unit.split[0].product.id, 2);
  assert.equal(unit.split[0].unit, undefined);
});

test("only products measured in the line's unit are compared per unit", () => {
  const flourSmall = sized(1, 500, "g"), flourBig = sized(2, 1000, "g"), litre = sized(3, 1000, "ml");
  const lines = [line(group("Mélange"), flourSmall, flourBig, litre)];
  const responses = new Map([[1, response(reading(1, 10, "1.50"))], [2, response(reading(2, 10, "2.40"))], [3, response(reading(3, 10, "0.50"))]]);
  assert.equal(compare(lines, responses, "price").split[0].product.id, 3, "by price the cheap litre wins");
  assert.equal(compare(lines, responses, "unit").split[0].product.id, 2, "per unit the grams are compared with each other");
  const ml = group("Mélange", { amount: "500", unit: "ml" });
  assert.equal(compare([line(ml, flourSmall, flourBig, litre)], responses, "unit", true).split[0].product.id, 3, "the requested unit decides");
});

test("a request in packages needs that many of the smallest pack, covered by fewer bigger ones", () => {
  const small = sized(1, 500, "g"), big = sized(2, 1000, "g");
  const lines = [line(group("Farine", { amount: "2", unit: "package" }), small, big)];
  const responses = new Map([[1, response(reading(1, 10, "1.50"))], [2, response(reading(2, 10, "2.40"))]]);
  const unit = compare(lines, responses, "unit", true);
  assert.deepEqual([unit.split[0].product.id, unit.split[0].packages, unit.splitCents, unit.split[0].unit.surplus], [2, 1, 240, 0]);
  assert.equal(compare(lines, responses, "price", true).splitCents, 300, "by price: two packs of 1.50");
});

test("per unit, lines sharing a product at a store share its packs", () => {
  const half = sized(1, 500, "g"), kilo = sized(2, 1000, "g");
  const first = { id: 1, revision: 1, data: half.data, quantity: { amount: "200", unit: "g" } };
  const second = group("Farine", { amount: "300", unit: "g" });
  const lines = [line(first, half), line(second, half, kilo)];
  const responses = new Map([[1, response(reading(1, 10, "1.00"))], [2, response(reading(2, 10, "2.40"))]]);
  const unit = compare(lines, responses, "unit", true);
  assert.equal(unit.stores[0].cents, 100, "200 g + 300 g fit one 500 g pack");
  assert.equal(unit.splitCents, 100);
});

test("equal prices per unit fall back to the smaller outlay", () => {
  const small = sized(1, 500, "g"), big = sized(2, 1000, "g");
  const lines = [line(group("Farine"), small, big)];
  const responses = new Map([[1, response(reading(1, 10, "1.00"))], [2, response(reading(2, 10, "2.00"))]]);
  assert.equal(compare(lines, responses, "unit").split[0].product.id, 1);
});

test("per unit, the saving of a store is the extra value of the needed amount without it", () => {
  const small = sized(1, 500, "g"), big = sized(2, 1000, "g");
  const lines = [line(group("Farine", { amount: "500", unit: "g" }), small, big)];
  const responses = new Map([[1, response(reading(1, 30, "1.50"))], [2, response(reading(2, 10, "2.40"), reading(3, 20, "2.60"))]]);
  const baseline = compare(lines, responses, "unit", true);
  const result = splitSavings(lines, responses, { storeIds: [], cities: [], departments: [] }, true, baseline, "unit");
  assert.deepEqual(result.get("10:in_store"), { extraCents: 10, unpriced: 0 }, "1.30 at store 20 instead of 1.20 at store 10 for 500 g");
  const withoutBig = compare(lines, new Map([[1, responses.get(1)], [2, response(reading(3, 20, "2.60"))]]), "unit", true);
  assert.equal(withoutBig.split[0].reading.store_id, 20);
});

test("the price mode is the default and ignores the unit machinery", () => {
  const { lines, responses } = flour();
  assert.equal(buildBasketComparison(lines, responses, undefined, true).split[0].unit, undefined);
  assert.equal(buildBasketComparison(lines, responses, undefined, true).splitCents, compare(lines, responses, "price", true).splitCents);
});

test("the prices the server left out for a withdrawn product are counted once per product", () => {
  const products = [product(1), product(2)];
  const results = new Map([
    [1, { ...response(reading(1, 10, "2.00")), withdrawn_count: 2 }],
    [2, response(reading(2, 10, "1.00"))],
  ]);
  // The same product in two lines (a group and a single article) is not counted twice.
  const lines = [line({ kind: "group", name: "Lait" }, products[0], products[1]), line(products[0], products[0])];
  assert.equal(buildBasketComparison(lines, results).withdrawn, 2);
  assert.equal(buildBasketComparison([line(products[1], products[1])], results).withdrawn, 0, "an older answer without the field counts none");
});
