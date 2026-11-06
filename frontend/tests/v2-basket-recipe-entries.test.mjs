import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const quantitySource = read("../src/recipes/quantity.ts");
// basket.ts with its one runtime import inlined; its type imports are erased.
const basketSource = read("../src/recipes/basket.ts").replace('import { scaledAmount } from "./quantity";', quantitySource);
assert.notEqual(basketSource, read("../src/recipes/basket.ts"), "basket.ts imports scaledAmount from ./quantity");
const load = source => import("data:text/javascript;base64," + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString("base64"));
const { scaledAmount, scaledQuantity } = await load(quantitySource);
const { recipeBasketEntries } = await load(basketSource);

const product = (id, group = "") => ({ id, revision: 1, data: { name: "Produit " + id, group } });
const ingredient = values => ({ label: "Ingrédient", amount: null, unit: null, note: "", optional: false, product_id: null, group_name: null, ...values });
const recipe = (ingredients, base_servings = "3.000") => ({ id: 1, revision: 1, title: "Recette", description: "", base_servings,
  prep_minutes: null, cook_minutes: null, steps: ["Cuire"], ingredients, created_at: "", updated_at: "" });
const choice = values => ({ products: [], resolved: {}, selected: {}, included: {}, ...values });

test("scaled quantities read the French way, exact or approximate", () => {
  assert.equal(scaledQuantity("1", "1", "3"), "≈ 0,333333");
  assert.equal(scaledQuantity("1.000", "4", "2.000"), "2");
  assert.equal(scaledQuantity("0.5", "3", "1"), "1,5");
  assert.equal(scaledQuantity("2", "0", "1"), "—");
  assert.equal(scaledQuantity("abc", "1", "1"), "—");
});

test("scaled amounts for the basket are plain decimals with six digits at most", () => {
  assert.equal(scaledAmount("1", "1", "3"), "0.333333");
  assert.equal(scaledAmount("1.000", "4", "2.000"), "2");
  assert.equal(scaledAmount("0.5", "3", "1"), "1.5");
  assert.equal(scaledAmount("0.001", "0.001", "999"), "0");
  assert.equal(scaledAmount("2", "0", "1"), null);
  assert.equal(scaledAmount("1e3", "1", "1"), null);
});

test("each ingredient becomes a basket line scaled to the servings", () => {
  const butter = product(7);
  const outcome = recipeBasketEntries(recipe([
    ingredient({ label: "Beurre", amount: "100.000", unit: "g", product_id: 7 }),
    ingredient({ label: "Oeufs", amount: "1.000", unit: "piece", group_name: "Oeufs" }),
  ]), "1", choice({ products: [butter] }));
  assert.deepEqual(outcome.entries, [
    { item: butter, quantity: { amount: "33.333333", unit: "g" } },
    { item: { kind: "group", name: "Oeufs" }, quantity: { amount: "0.333333", unit: "piece" } },
  ]);
  const doubled = recipeBasketEntries(recipe([ingredient({ amount: "1.000", unit: "kg", product_id: 7 })], "2.000"), "4", choice({ products: [butter] }));
  assert.deepEqual(doubled.entries[0].quantity, { amount: "2", unit: "kg" });
});

test("an ingredient without quantity counts as one package", () => {
  const outcome = recipeBasketEntries(recipe([ingredient({ group_name: "Sel" })]), "3", choice({}));
  assert.deepEqual(outcome.entries, [{ item: { kind: "group", name: "Sel" }, quantity: { amount: "1", unit: "package" } }]);
});

test("an optional ingredient is left out unless the reader ticked it", () => {
  const ingredients = [ingredient({ label: "Sel", group_name: "Sel" }), ingredient({ label: "Poivre", optional: true, group_name: "Poivre" })];
  assert.deepEqual(recipeBasketEntries(recipe(ingredients), "3", choice({})).entries.map(entry => entry.item.name), ["Sel"]);
  assert.deepEqual(recipeBasketEntries(recipe(ingredients), "3", choice({ included: { 1: true } })).entries.map(entry => entry.item.name), ["Sel", "Poivre"]);
  assert.deepEqual(recipeBasketEntries(recipe([ingredients[1]]), "3", choice({})), { error: "Aucun ingrédient sélectionné." });
});

test("a product picked in the group comes first, then the referenced product or its replacement", () => {
  const picked = product(2, "Lait");
  const replacement = product(9);
  const ingredients = [ingredient({ label: "Lait", group_name: "Lait" }), ingredient({ label: "Crème", product_id: 5 })];
  const outcome = recipeBasketEntries(recipe(ingredients), "3", choice({ products: [picked], resolved: { 5: replacement }, selected: { 0: 2 } }));
  assert.deepEqual(outcome.entries.map(entry => entry.item), [picked, replacement]);
});

test("nothing is added when an ingredient has no product or no valid quantity", () => {
  const unavailable = labels => ({ error: "Ingrédients sans produit disponible ou quantité valide : " + labels + ". Aucun ingrédient ajouté." });
  const sel = ingredient({ label: "Sel", group_name: "Sel" });
  // A product that left the catalogue without replacement, or a pick no longer published.
  assert.deepEqual(recipeBasketEntries(recipe([sel, ingredient({ label: "Crème", product_id: 5 })]), "3", choice({})), unavailable("Crème"));
  assert.deepEqual(recipeBasketEntries(recipe([sel, ingredient({ label: "Lait", group_name: "Lait" })]), "3", choice({ selected: { 1: 2 } })), unavailable("Lait"));
  // Above the basket's largest quantity, or so small it rounds to nothing.
  assert.deepEqual(recipeBasketEntries(recipe([sel, ingredient({ label: "Farine", amount: "999999.000", unit: "g", group_name: "Farine" })], "1"), "2", choice({})), unavailable("Farine"));
  assert.deepEqual(recipeBasketEntries(recipe([sel, ingredient({ label: "Safran", amount: "0.001", unit: "g", group_name: "Safran" }),
    ingredient({ label: "Vanille", amount: "0.001", unit: "g", group_name: "Vanille" })], "999"), "0.001", choice({})), unavailable("Safran, Vanille"));
  // With no line at all, saying so comes first.
  assert.deepEqual(recipeBasketEntries(recipe([ingredient({ label: "Crème", product_id: 5 })]), "3", choice({})), { error: "Aucun ingrédient sélectionné." });
});
