import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import QRCode from "qrcode";

const storageSource = readFileSync(new URL("../src/v2/v2-basket-storage.ts", import.meta.url), "utf8");
const source = readFileSync(new URL("../src/v2/v2-basket-share.ts", import.meta.url), "utf8")
  .replace('import { validBasketQuantity, type BasketItem, type BasketQuantity } from "./v2-basket-storage";', storageSource);
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { encodeBasketShare, decodeBasketShare, sharedEntryName } =
  await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
const labelsSource = readFileSync(new URL("../src/v2/v2-basket-share-labels.ts", import.meta.url), "utf8");
const labelsOutput = ts.transpileModule(labelsSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { basketQuantityLabel, basketShareList } = await import("data:text/javascript;base64," + Buffer.from(labelsOutput).toString("base64"));

test("shared basket round-trips Unicode, exclusions and distinct item types", () => {
  const items = [
    { id: 14, revision: 2, data: { brand: "Côte d’Or", name: "Chocolat noir" } },
    { kind: "group", name: "Jus d’orange", disabled: true },
    { kind: "scope", name: "Céréales", department: "Épicerie", family: "Petit déjeuner" },
  ];
  const hash = encodeBasketShare(items);
  assert.match(hash, /^#panier=[A-Za-z0-9_-]+$/);
  const decoded = decodeBasketShare(hash);
  assert.deepEqual(decoded, [
    ["p", 14, "Côte d’Or Chocolat noir", 0],
    ["g", "Jus d’orange", 1],
    ["s", "Épicerie", "Petit déjeuner", "Céréales", 0],
  ]);
  assert.equal(sharedEntryName(decoded[1]), "Jus d’orange");
});

test("malformed, duplicate and excessive shared baskets are rejected", () => {
  assert.equal(decodeBasketShare("#panier=not-base64"), null);
  assert.equal(decodeBasketShare("#panier="), null);
  assert.equal(encodeBasketShare([]), null);
  assert.equal(encodeBasketShare(Array.from({ length: 101 }, (_, i) =>
    ({ id: i + 1, revision: 1, data: { name: "Produit" } }))), null);
  const duplicate = btoa(JSON.stringify([1, [["g", "Lait", 0], ["g", "lait", 1]]])).replace(/=+$/, "");
  assert.equal(decodeBasketShare("#panier=" + duplicate), null);
});

test("shared advanced quantities survive round trip and malformed quantities are rejected", () => {
  const hash = encodeBasketShare([{ kind: "group", name: "Beurre", quantity: { amount: "20", unit: "g" } }]);
  assert.deepEqual(decodeBasketShare(hash), [["g", "Beurre", 0, { amount: "20", unit: "g" }]]);
  const malformed = btoa(JSON.stringify([2, [["g", "Beurre", 0, { amount: "-20", unit: "g" }]]])).replace(/=+$/, "");
  assert.equal(decodeBasketShare("#panier=" + malformed), null);
});

test("copyable list and QR link preserve explicit quantities and exclusions", async () => {
  const items = [
    { id: 14, revision: 2, data: { brand: "Côte d’Or", name: "Chocolat noir" }, quantity: { amount: "2.5", unit: "package" } },
    { kind: "group", name: "Beurre", quantity: { amount: "20", unit: "g" }, disabled: true },
    { kind: "scope", name: "Céréales", department: "Épicerie", family: "Petit déjeuner" },
  ];
  const url = "https://dev-price-checker/v2/panier" + encodeBasketShare(items);
  const list = basketShareList(items, url);
  assert.match(list, /Chocolat noir — 2\.5 paquet\(s\)/);
  assert.match(list, /Beurre — 20 g \(exclu du calcul\)/);
  assert.match(list, /Céréales — 1 paquet/);
  assert.equal(basketQuantityLabel(), "1 paquet");
  assert.deepEqual(decodeBasketShare(new URL(url).hash)[0][4], { amount: "2.5", unit: "package" });
  assert.match(await QRCode.toDataURL(url, { errorCorrectionLevel: "L" }), /^data:image\/png;base64,/);
  assert.doesNotMatch(basketShareList(items, null), /Ouvrir ce panier/);
});
