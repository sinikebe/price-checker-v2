import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-basket-share.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { encodeBasketShare, decodeBasketShare, sharedEntryName } =
  await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

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
