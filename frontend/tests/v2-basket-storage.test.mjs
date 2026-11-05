import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-basket-storage.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key),
};
globalThis.window = { dispatchEvent: () => {} };
const { readV2Basket, writeV2Basket, activateBasketUser, withProductData, basketItemKey, isFreeText, isPriceable, validSelection } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
const product = { id: 1, revision: 1, data: { name: "Jus" } };
const group = { kind: "group", name: "Jus d'orange" };
const scope = { kind: "scope", name: "Jus", department: "Boissons", family: "Jus de fruits" };

test("legacy product baskets remain readable alongside groups and ensembles", () => {
  storage.clear();
  storage.set("v2:basket:anonymous", JSON.stringify([product]));
  assert.deepEqual(readV2Basket(null), [product]);
  writeV2Basket([product, group, scope], null);
  assert.deepEqual(readV2Basket(null), [product, group, scope]);
});

test("login merges offline entries without duplicating an existing group", () => {
  storage.clear();
  writeV2Basket([product, group, scope], null);
  writeV2Basket([group], 42);
  activateBasketUser(42);
  assert.deepEqual(readV2Basket(42), [group, product, scope]);
  assert.deepEqual(readV2Basket(null), []);
});


test("disabled articles remain in the local basket without changing identity", () => {
  storage.clear();
  writeV2Basket([{ ...group, disabled: true }, product], null);
  assert.deepEqual(readV2Basket(null), [{ ...group, disabled: true }, product]);
});

test("refreshing a product keeps the quantity and the excluded flag of its line", () => {
  const line = { id: 1, revision: 1, data: { name: "Jus" }, quantity: { amount: "2", unit: "l" }, disabled: true };
  assert.deepEqual(withProductData(line, { data: { name: "Jus d'orange" }, revision: 4 }),
    { id: 1, revision: 4, data: { name: "Jus d'orange" }, quantity: { amount: "2", unit: "l" }, disabled: true });
  assert.deepEqual(withProductData(product, { data: { name: "Jus 2" }, revision: 2 }), { id: 1, revision: 2, data: { name: "Jus 2" } });
});


test("free text is a basket line of its own: kept, keyed by its words, never priced", () => {
  const text = { kind: "text", name: "Sauce tomate maison", quantity: { amount: "2", unit: "package" } };
  writeV2Basket([text, { kind: "text", name: "" }, { kind: "text" }], 42);
  assert.deepEqual(readV2Basket(42), [text], "an empty text is dropped");
  assert.equal(basketItemKey(text), "text:sauce tomate maison");
  assert.notEqual(basketItemKey(text), basketItemKey({ kind: "group", name: "Sauce tomate maison" }), "a text and a group of the same name are two lines");
  assert.equal(isFreeText(text), true);
  assert.equal(isPriceable(text), false);
  assert.equal(isPriceable({ kind: "group", name: "Lait" }), true);
});


test("a selection is kept with its parts, keyed by its name, and priced like a group", () => {
  const selection = { kind: "selection", name: "Jus de fruits bio", include: [{ family: "Jus de fruits" }], words: ["bio"] };
  assert.equal(basketItemKey(selection), "selection:jus de fruits bio");
  assert.equal(isPriceable(selection), true);
  assert.equal(validSelection(selection), true);
  for (const wrong of [
    { ...selection, include: [] }, { ...selection, include: [{}] }, { ...selection, include: [{ product: 2, group: "Lait" }] },
    { ...selection, include: [{ group: "Lait", family: "Lait" }] }, { ...selection, words: ["x".repeat(41)] }, { ...selection, name: " " },
    { ...selection, include: Array(21).fill({ group: "Lait" }) }, { ...selection, exclude: [{ product: 0 }] },
  ]) assert.equal(validSelection(wrong), false, JSON.stringify(wrong));
  assert.equal(validSelection({ ...selection, include: [{ scope: "Pâtes sèches", family: "Pâtes", department: "Épicerie" }] }), true);
  localStorage.setItem("v2:basket:anonymous", JSON.stringify([selection, { ...selection, name: "Cassé", include: [] }]));
  assert.deepEqual(readV2Basket(null), [selection]);
});

test("a product known only by its barcode keeps the name this browser read when the server refreshes it", () => {
  const local = { id: 9, revision: 1, off_reference: true, data: { name: "Pâte à tartiner", brand: "Nutella", quantity: "400 g", ean: "3017620422003" } };
  const refreshed = withProductData(local, { revision: 1, off_reference: true, data: { name: "", brand: "", quantity: "", ean: "3017620422003" } });
  assert.equal(refreshed.data.name, "Pâte à tartiner");
  assert.equal(refreshed.data.brand, "Nutella");
  assert.equal(refreshed.off_reference, true);
  // Once completed by an approved proposal, the catalogue's facts win and the mark goes.
  const completed = withProductData(local, { revision: 2, off_reference: false, data: { name: "Nutella", brand: "Ferrero", quantity: "400 g", ean: "3017620422003" } });
  assert.equal(completed.data.name, "Nutella");
  assert.equal("off_reference" in completed, false);
});
