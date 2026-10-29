import type { Product } from "../v2/v2-products-api";
import type { Recipe, RecipeSummary } from "../v2/v2-recipes-api";
import { isBasketProduct, readV2Basket, writeV2Basket } from "../v2/v2-basket-storage";

import { PWA_CACHE_NAME, PWA_RECIPES_KEY, PWA_RECIPES_READY_KEY } from "./cache-keys";
async function cache() { return "caches" in window ? caches.open(PWA_CACHE_NAME) : null; }

export async function cacheRecipeWrite(method: string, path: string, result: Recipe | undefined) {
  try {
    const store = await cache();
    if (!store) return;
    const id = result?.id ?? Number(path.match(/^\/(\d+)$/)?.[1]);
    for (const request of await store.keys()) {
      if (new URL(request.url).pathname === "/api/v2/recipes") await store.delete(request);
    }
    if (method === "DELETE") await store.delete(`/api/v2/recipes/${id}`);
    else if (result) await store.put(`/api/v2/recipes/${id}`, new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } }));
    const raw = localStorage.getItem(PWA_RECIPES_KEY);
    const list: RecipeSummary[] = raw ? JSON.parse(raw) : [];
    const next = list.filter(item => item.id !== id);
    if (result) next.push({ id: result.id, title: result.title, description: result.description, base_servings: result.base_servings, prep_minutes: result.prep_minutes, cook_minutes: result.cook_minutes, updated_at: result.updated_at, revision: result.revision, ingredient_count: result.ingredients.length });
    localStorage.setItem(PWA_RECIPES_KEY, JSON.stringify(next));
    localStorage.setItem(PWA_RECIPES_READY_KEY, "1");
  } catch { /* online save succeeded; cache is best-effort */ }
}

export async function cacheApprovedProduct(product: Product) {
  try {
    const store = await cache();
    if (!store) return;
    await store.delete("/api/v2/products");
    await store.put(`/api/v2/products/${product.id}`, new Response(JSON.stringify(product), { headers: { "Content-Type": "application/json" } }));
    const basket = readV2Basket();
    if (basket.some(item => isBasketProduct(item) && item.id === product.id)) writeV2Basket(basket.map(item => isBasketProduct(item) && item.id === product.id ? { id: product.id, data: product.data, revision: product.revision } : item));
  } catch { /* cache is best-effort */ }
}
