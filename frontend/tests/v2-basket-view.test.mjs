import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-basket-view.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { reactivationText, savingText, unitPriceText, surplusText, selectionSummary, itemKind, itemHref, money, euros, alternatives, alternativesIndex } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
const plain = text => text.replace(/[  ]/g, " ");

test("amounts read the French way, from cents or from the API's decimal text", () => {
  assert.equal(plain(money(150)), "1,50 €");
  // Prices of drafts and captures used to show as "1.50 €".
  assert.equal(plain(euros("1.50")), "1,50 €");
  assert.equal(plain(euros(1.5)), "1,50 €");
  assert.equal(plain(euros("1234.5")), "1 234,50 €");
});

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

test("putting back a store left out says what it brings, or why it matters", () => {
  assert.equal(reactivationText({ extraCents: 50, unpriced: 0 }).kind, "saving");
  assert.equal(plain(reactivationText({ extraCents: 50, unpriced: 0 }).text), "Le réactiver ferait gagner 0,50 €");
  assert.equal(plain(reactivationText({ extraCents: 50, unpriced: 0 }, "unit").text), "Le réactiver ferait gagner 0,50 € sur la quantité utile");
  assert.deepEqual(reactivationText({ extraCents: 0, unpriced: 0 }), { kind: "none", text: "Le réactiver ne ferait rien gagner" });
  assert.equal(reactivationText({ extraCents: 0, unpriced: 2 }).text, "Seul magasin avec un prix pour 2 articles");
  assert.equal(plain(reactivationText({ extraCents: 120, unpriced: 1 }).text), "Seul magasin avec un prix pour 1 article · 1,20 € de moins sur les autres");
});


test("a selection reads as its parts, its exclusions and its words", () => {
  const selection = { kind: "selection", name: "Jus", include: [{ family: "Jus de fruits", department: "Boissons" }, { product: 7 }],
    exclude: [{ group: "Nectar de pomme" }], words: ["bio"] };
  assert.equal(selectionSummary(selection), "Jus de fruits (famille), n° 7 (produit) · sauf Nectar de pomme (groupe) · avec « bio »");
  assert.equal(itemKind(selection), "Sélection");
  assert.equal(itemHref(selection), "/v2/produits?rayon=Boissons&famille=Jus+de+fruits");
  assert.equal(itemHref({ ...selection, include: [{ group: "Lait" }] }), "/v2/categories/Lait");
});

// The comparison choices as they were worked out before the index: one scan of the categories per article.
const fold = value => value.toLocaleLowerCase("fr");
function scannedAlternatives(item, categories) {
  if (!("kind" in item) || item.kind === "text" || item.kind === "selection") return [];
  const group = item.kind === "group" ? categories.find(category => fold(category.name) === fold(item.name)) : null;
  if (item.kind === "group" && !group?.comparison_scope) return [];
  const location = item.kind === "scope" ? item : group;
  const scope = item.kind === "scope" ? item.name : group.comparison_scope;
  const members = categories.filter(category => fold(category.department) === fold(location.department)
    && fold(category.family) === fold(location.family)
    && fold(category.comparison_scope ?? "") === fold(scope));
  if (!members.length) return [];
  return [
    { kind: "scope", name: scope, department: location.department, family: location.family },
    ...members.map(category => ({ kind: "group", name: category.name })),
  ];
}

test("the comparison choices of each article are the same from the index as from a scan of the categories", () => {
  const category = (name, department, family, comparison_scope) => ({ name, department, family, comparison_scope });
  const categories = [
    category("Pâtes", "Épicerie", "Pâtes", "Pâtes longues"),
    category("Spaghetti", "épicerie", "PÂTES", "pâtes longues"),
    // The same name folded: the first one wins, so this scope is never reached from the name.
    category("PÂTES", "Épicerie", "Pâtes", "Autre"),
    category("Tagliatelle", "ÉPICERIE", "pâtes", "PÂTES LONGUES"),
    // Without the accent, another department.
    category("Coquillettes", "Epicerie", "Pâtes", "Pâtes longues"),
    category("Lait", "Crèmerie", "Lait", null),
    category("Lait demi-écrémé", "Crèmerie", "Lait", null),
    category("Vide", "Crèmerie", "Lait", ""),
    // A separator inside the names must not join two places.
    category("A", "X|Y", "Z", "S"),
    category("B", "X", "Y|Z", "S"),
    category("C", "X", "Y", "Z|S"),
  ];
  const items = [
    { kind: "group", name: "pâtes" }, { kind: "group", name: "PÂTES" }, { kind: "group", name: "Spaghetti" }, { kind: "group", name: "Coquillettes" },
    { kind: "group", name: "Lait" }, { kind: "group", name: "Vide" }, { kind: "group", name: "Inconnu" }, { kind: "group", name: "A" }, { kind: "group", name: "B" },
    { kind: "scope", name: "Pâtes longues", department: "épicerie", family: "pâtes" }, { kind: "scope", name: "PÂTES LONGUES", department: "Epicerie", family: "Pâtes" },
    { kind: "scope", name: "S", department: "X|Y", family: "Z" }, { kind: "scope", name: "S", department: "X", family: "Y|Z" },
    { kind: "scope", name: "Z|S", department: "X", family: "Y" }, { kind: "scope", name: "S", department: "X", family: "Y" },
    { kind: "scope", name: "Rien", department: "Épicerie", family: "Pâtes" },
    { id: 1, revision: 1, data: { name: "Pâtes" } }, { kind: "text", name: "Pâtes" },
    { kind: "selection", name: "Pâtes", include: [{ group: "Pâtes" }], exclude: [], words: [] },
  ];
  const choicesOf = alternativesIndex(categories);
  for (const item of items) {
    const expected = scannedAlternatives(item, categories);
    assert.deepEqual(choicesOf(item), expected, JSON.stringify(item));
    assert.deepEqual(alternatives(item, categories), expected, JSON.stringify(item));
  }
  assert.deepEqual(choicesOf({ kind: "group", name: "pâtes" }).map(choice => `${choice.kind}:${choice.name}`),
    ["scope:Pâtes longues", "group:Pâtes", "group:Spaghetti", "group:Tagliatelle"], "the ensemble first, then its groups in the catalogue's order");
  assert.deepEqual(choicesOf({ kind: "group", name: "Lait" }), [], "a group without a comparison scope has no other choice");
  assert.deepEqual(alternativesIndex([])({ kind: "scope", name: "S", department: "X", family: "Y" }), []);
});
