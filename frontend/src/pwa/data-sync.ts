import {
  PWA_CACHE_GENERATION, PWA_CACHE_GENERATION_KEY, PWA_CACHE_NAME,
  PWA_PREVIOUS_CACHE_NAME, PWA_RECIPES_KEY, PWA_RECIPES_READY_KEY,
  PWA_SYNC_ATTEMPT_KEY, PWA_VERSIONS_KEY,
} from "./cache-keys";
import { activeBasketUser, isBasketProduct, readV2Basket, withProductData, writeV2Basket } from "../v2/v2-basket-storage";
import type { Product } from "../v2/v2-products-api";
import type { Recipe, RecipeSummary } from "../v2/v2-recipes-api";

const TEN_MINUTES = 10 * 60 * 1000;
export const SYNC_EVENT = "v2-pwa-data-synced";
type Versions = { products: number; recipes: number; user_id: number | null };
let pending: Promise<void> | null = null;

function readJson<T>(key: string): T | null {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") as T | null; } catch { return null; }
}

async function fresh<T>(path: string, cache: Cache): Promise<T> {
  const response = await fetch(path, { headers: { "X-PWA-Sync": "1" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Sync ${path}: ${response.status}`);
  await cache.put(path, response.clone());
  return response.json() as Promise<T>;
}

async function syncRecipes(cache: Cache) {
  const items: RecipeSummary[] = [];
  for (let page = 1; ; page++) {
    const result = await fresh<{ items: RecipeSummary[]; total: number }>(`/api/v2/recipes?page=${page}&page_size=100`, cache);
    items.push(...result.items);
    if (items.length >= result.total || !result.items.length) break;
  }
  const ids = new Set(items.map(item => item.id));
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    if (url.pathname === "/api/v2/recipes") await cache.delete(request);
    const match = url.pathname.match(/^\/api\/v2\/recipes\/(\d+)$/);
    if (match && !ids.has(Number(match[1]))) await cache.delete(request);
  }
  for (const item of items) {
    const path = `/api/v2/recipes/${item.id}`;
    const cached = await cache.match(path);
    const recipe: Recipe | null = cached ? await cached.json().catch(() => null) : null;
    if (!recipe || recipe.revision !== item.revision) await fresh<Recipe>(path, cache);
  }
  localStorage.setItem(PWA_RECIPES_KEY, JSON.stringify(items));
  localStorage.setItem(PWA_RECIPES_READY_KEY, "1");
}

async function withdrawnProducts(): Promise<Set<number>> {
  const response = await fetch("/api/v2/moderation/withdrawn", { cache: "no-store" });
  if (!response.ok) throw new Error("Withdrawal list unavailable");
  const data = await response.json() as { product_ids: number[] };
  return new Set(data.product_ids);
}

async function syncProducts(cache: Cache, userId: number | null) {
  const withdrawn = await withdrawnProducts();
  const catalog = await fresh<Product[]>("/api/v2/products", cache);
  for (const request of await cache.keys()) {
    const match = new URL(request.url).pathname.match(/^\/api\/v2\/products\/(\d+)$/);
    if (match && withdrawn.has(Number(match[1]))) await cache.delete(request);
  }
  const current = readV2Basket(userId).filter(isBasketProduct).filter(item => !withdrawn.has(item.id));
  if (!current.length) {
    const latest = readV2Basket(userId);
    if (latest.some(item => isBasketProduct(item) && withdrawn.has(item.id)))
      writeV2Basket(latest.filter(item => !isBasketProduct(item) || !withdrawn.has(item.id)), userId);
    return;
  }
  const byId = new Map(catalog.map(product => [product.id, product]));
  const refreshed = new Map<number, Product>();
  for (const item of current) {
    const product = byId.get(item.id) ?? await fresh<Product>("/api/v2/products/" + item.id, cache);
    refreshed.set(item.id, product);
    await cache.put("/api/v2/products/" + item.id, new Response(JSON.stringify(product), { headers: { "Content-Type": "application/json" } }));
  }
  // Preserve membership edits made in another tab while product requests were pending.
  const latest = readV2Basket(userId);
  writeV2Basket(latest.filter(item => !isBasketProduct(item) || !withdrawn.has(item.id)).map(item => {
    if (!isBasketProduct(item)) return item;
    const product = refreshed.get(item.id);
    return product ? withProductData(item, product) : item;
  }), userId);
}

export function offlineRecipeSummaries(): RecipeSummary[] {
  const value = readJson<unknown>(PWA_RECIPES_KEY);
  return Array.isArray(value) ? value as RecipeSummary[] : [];
}

async function run() {
  if ("caches" in window) await caches.delete(PWA_PREVIOUS_CACHE_NAME);
  if (!navigator.onLine || !window.location.pathname.startsWith("/v2")) return;
  const userId = activeBasketUser();
  const attemptKey = `${PWA_SYNC_ATTEMPT_KEY}:${userId ?? "anon"}`;
  const versionsKey = `${PWA_VERSIONS_KEY}:${userId ?? "anon"}`;
  const last = Number(localStorage.getItem(attemptKey) || 0);
  if (Date.now() - last < TEN_MINUTES && localStorage.getItem(PWA_CACHE_GENERATION_KEY) === PWA_CACHE_GENERATION) return;
  localStorage.setItem(attemptKey, String(Date.now()));
  const previous = localStorage.getItem(PWA_CACHE_GENERATION_KEY) === PWA_CACHE_GENERATION ? readJson<Versions>(versionsKey) : null;
  const cache = await caches.open(PWA_CACHE_NAME);
  const cachedCatalog = await cache.match("/api/v2/products");
  const etag = previous && cachedCatalog && localStorage.getItem(PWA_RECIPES_READY_KEY) === "1"
    ? '"u' + (previous.user_id ?? "anon") + '-p' + previous.products + '-r' + previous.recipes + '"' : null;
  const response = await fetch("/api/v2/sync/versions", {
    cache: "no-store", headers: etag ? { "If-None-Match": etag } : undefined,
  });
  if (response.status === 304) return;
  if (!response.ok) throw new Error("Version sync unavailable");
  const versions = await response.json() as Versions;
  if (activeBasketUser() !== userId || versions.user_id !== userId) return;
  if (!previous || previous.recipes !== versions.recipes || localStorage.getItem(PWA_RECIPES_READY_KEY) !== "1") await syncRecipes(cache);
  if (!previous || previous.products !== versions.products) await syncProducts(cache, userId);
  if (activeBasketUser() !== userId) return;
  localStorage.setItem(versionsKey, JSON.stringify(versions));
  localStorage.setItem(PWA_CACHE_GENERATION_KEY, PWA_CACHE_GENERATION);
  window.dispatchEvent(new Event(SYNC_EVENT));
}

export function syncV2Data() {
  if (!pending) pending = run().catch(() => { /* last good offline data remains intact */ }).finally(() => { pending = null; });
  return pending;
}
