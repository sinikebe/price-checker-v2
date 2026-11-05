import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-off-browser.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { parseOffProduct, parseOffSearch, offImage, validBarcode } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

const answer = product => ({ status: 1, product: { code: "3017620422003", product_name: "Pâte à tartiner", brands: "Nutella, Ferrero", quantity: "400 g", ...product } });

test("a product answer gives what the page shows, and only Open Food Facts images", () => {
  const product = parseOffProduct(answer({
    nutriscore_grade: "e", nova_group: 4, ingredients_text_fr: "Sucre, huile de palme", ingredients_text: "Sugar",
    image_front_small_url: "https://images.openfoodfacts.org/images/products/front.jpg", last_modified_t: 1793573251,
    nutriments: { "energy-kcal_100g": 539, "fat_100g": 30.9, "salt_100g": 0.107, "sugars_100g": "56", "fiber_100g": -1 },
  }));
  assert.equal(product.brand, "Nutella");
  assert.equal(product.nutriscore, "E");
  assert.equal(product.nova, "4");
  assert.equal(product.ingredients, "Sucre, huile de palme");
  assert.equal(product.image, "https://images.openfoodfacts.org/images/products/front.jpg");
  assert.deepEqual(product.nutrition.map(row => row.label), ["Énergie", "Matières grasses", "Sel"]);
  assert.match(product.modifiedAt, /^2026-/);
  assert.equal(parseOffProduct(answer({ image_front_small_url: "https://elsewhere.example/a.jpg" })).image, null);
});

test("unknown products, bad grades and bad barcodes are left out", () => {
  assert.equal(parseOffProduct({ status: 0 }), null);
  assert.equal(parseOffProduct(null), null);
  assert.equal(parseOffProduct(answer({ code: "12" })), null);
  const odd = parseOffProduct(answer({ nutriscore_grade: "unknown", nova_group: 9, ingredients_text: "Sugar" }));
  assert.equal(odd.nutriscore, ""); assert.equal(odd.nova, ""); assert.equal(odd.ingredients, "Sugar");
  assert.equal(offImage("http://images.openfoodfacts.org/a.jpg"), null);
  assert.equal(validBarcode("3017620422003"), true);
  assert.equal(validBarcode("301762042200"), true);
  assert.equal(validBarcode("1234"), false);
});

test("a search answer keeps the products with a usable barcode", () => {
  const results = parseOffSearch({ products: [{ code: "3017620422003", product_name: "Nutella", brands: ["Ferrero"] }, { code: "abc" }, null] });
  assert.deepEqual(results, [{ code: "3017620422003", name: "Nutella", brand: "Ferrero", quantity: "", image: null }]);
  assert.deepEqual(parseOffSearch({}), []);
});
