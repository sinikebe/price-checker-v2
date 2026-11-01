import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-basket-view.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { savingText, unitPriceText, surplusText } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
const plain = text => text.replace(/[  ]/g, " ");

test("a store that lowers the basket says how much, and what share of the price without it", () => {
  const note = savingText({ extraCents: 120, unpriced: 0 }, 3880, false);
  assert.equal(note.kind, "saving");
  assert.equal(plain(note.text), "Économie grâce à ce magasin : 1,20 € (3 %)");
  assert.equal(plain(savingText({ extraCents: 1, unpriced: 0 }, 100000, false).text), "Économie grâce à ce magasin : 0,01 € (1 %)", "never shown as 0 %");
});

test("a store whose prices are matched elsewhere brings no saving", () => {
  assert.deepEqual(savingText({ extraCents: 0, unpriced: 0 }, 1000, false), { kind: "none", text: "Aucune économie : les mêmes prix existent ailleurs" });
});

test("a store that alone prices some articles is not compared on them", () => {
  assert.equal(savingText({ extraCents: 0, unpriced: 1 }, 1000, false).text, "Seul magasin avec un prix pour 1 article");
  assert.equal(plain(savingText({ extraCents: 50, unpriced: 2 }, 1000, false).text),
    "Seul magasin avec un prix pour 2 articles · économie sur les autres articles : 0,50 €");
  assert.deepEqual(savingText({ extraCents: 0, unpriced: 4 }, 1000, true), { kind: "only", text: "Seul magasin avec un prix pour ce panier" });
});

test("the price per unit is shown per kilogram, litre or piece", () => {
  assert.equal(plain(unitPriceText({ perUnitCents: 0.24, unit: "g", surplus: 0 })), "2,40 € / kg");
  assert.equal(plain(unitPriceText({ perUnitCents: 0.09, unit: "ml", surplus: 0 })), "0,90 € / L");
  assert.equal(plain(unitPriceText({ perUnitCents: 35, unit: "piece", surplus: 0 })), "0,35 € / pièce");
});

test("what is left after the need reads in the natural unit, and nothing is said for a negligible rest", () => {
  assert.equal(plain(surplusText({ perUnitCents: 1, unit: "g", surplus: 500 })), "Reste après vos besoins : 500 g");
  assert.equal(plain(surplusText({ perUnitCents: 1, unit: "g", surplus: 4500 })), "Reste après vos besoins : 4,5 kg");
  assert.equal(plain(surplusText({ perUnitCents: 1, unit: "ml", surplus: 5000 })), "Reste après vos besoins : 5 L");
  assert.equal(plain(surplusText({ perUnitCents: 1, unit: "ml", surplus: 250 })), "Reste après vos besoins : 250 ml");
  assert.equal(plain(surplusText({ perUnitCents: 1, unit: "piece", surplus: 11 })), "Reste après vos besoins : 11 pièces");
  assert.equal(plain(surplusText({ perUnitCents: 1, unit: "piece", surplus: 1 })), "Reste après vos besoins : 1 pièce");
  assert.equal(surplusText({ perUnitCents: 1, unit: "g", surplus: 0 }), null);
  assert.equal(surplusText({ perUnitCents: 1, unit: "g", surplus: 0.4 }), null);
  assert.equal(surplusText({ perUnitCents: 1, unit: "piece", surplus: 0.2 }), null);
});

test("per unit, the saving is worded on the value of the quantity needed", () => {
  const unit = savingText({ extraCents: 10, unpriced: 0 }, 120, false, "unit");
  assert.equal(unit.kind, "saving");
  assert.equal(plain(unit.text), "Économie à l’unité : 0,10 € sur la quantité utile (8 %)");
  assert.equal(savingText({ extraCents: 0, unpriced: 0 }, 120, false, "unit").text, "Aucune économie : le même prix à l’unité existe ailleurs");
  assert.equal(plain(savingText({ extraCents: 10, unpriced: 0 }, 120, false).text), "Économie grâce à ce magasin : 0,10 € (8 %)", "the price mode keeps its wording");
});
