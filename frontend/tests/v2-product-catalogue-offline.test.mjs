import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule } from "./fixtures/react-harness.mjs";

// Offline, the catalogue answers from the product list the service worker keeps.
const products = [
  { id: 1, data: { name: "Jus d’orange", brand: "Soleil", group: "Jus d’orange", tags: [] } },
  { id: 2, data: { name: "Jus de pomme", brand: "Verger", group: "Jus de pomme", tags: [] } },
];
let listReads = 0;
const { catalogueRequest, suggest } = await loadModule("v2-catalogue-data.ts", {
  "./v2-catalogue-api": { suggestRequest: async () => { throw new TypeError("Failed to fetch"); } },
  "./v2-catalogue-search": await loadModule("v2-catalogue-search.ts"),
  "./v2-products-api": { productRequest: async path => { assert.equal(path, ""); listReads += 1; return products; } },
});
globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

test("offline, the index and the search are built from the local product list", async () => {
  const categories = await catalogueRequest("/categories");
  assert.deepEqual(categories.map(item => [item.name, item.product_count, item.department]),
    [["Jus d’orange", 1, "À classer"], ["Jus de pomme", 1, "À classer"]]);
  const found = await catalogueRequest("/search?q=pomme&category=&limit=10&offset=0");
  assert.deepEqual(found.items.map(item => item.id), [2]);
  assert.equal(found.total, 1);
  const typed = await suggest("orange", { category: "", storeId: 0 }, new AbortController().signal);
  assert.deepEqual(typed.items.map(item => item.id), [1]);
});

test("offline, what needs the server is refused without reading the product list", async () => {
  listReads = 0;
  await assert.rejects(catalogueRequest("/search?q=jus&store_id=4"), { message: "Le filtre magasin nécessite une connexion." });
  await assert.rejects(suggest("jus", { category: "", storeId: 4 }, new AbortController().signal), { message: "Le filtre magasin nécessite une connexion." });
  await assert.rejects(catalogueRequest("/stores?q=au"), { message: "Cette recherche n’est pas disponible hors ligne." });
  assert.equal(listReads, 0);
});
