import { activeBasketUser, basketImportedKey, basketOpsKey, readBasketOps, readV2Basket, writeV2Basket, type BasketOp, type BasketProduct } from "../v2/v2-basket-storage";
import type { Product } from "../v2/v2-products-api";
import type { Recipe, RecipeSummary } from "../v2/v2-recipes-api";

const TEN_MINUTES = 10 * 60 * 1000;
const ATTEMPT_KEY = "v2:pwa:sync-attempt";
const VERSIONS_KEY = "v2:pwa:versions";
const RECIPES_KEY = "v2:pwa:recipe-summaries";
const RECIPES_READY_KEY = "v2:pwa:recipe-summaries-ready";
const CACHE_GENERATION_KEY = "v2:pwa:cache-generation";
const CACHE_NAME = "price-checker-offline-data-v3";
export const SYNC_EVENT = "v2-pwa-data-synced";
type Versions = { products: number; recipes: number; user_id: number | null };
type LegacyBasket = { product_ids: number[] };
let pending: Promise<void> | null = null;
let basketPending: Promise<void> | null = null;

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
  localStorage.setItem(RECIPES_KEY, JSON.stringify(items));
  localStorage.setItem(RECIPES_READY_KEY, "1");
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
  const current = readV2Basket(userId).filter(item => !withdrawn.has(item.id));
  if (!current.length) {
    if (readV2Basket(userId).length) writeV2Basket([], userId);
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
  writeV2Basket(latest.filter(item => !withdrawn.has(item.id)).map(item => {
    const product = refreshed.get(item.id);
    return product ? { id: item.id, data: product.data, revision: product.revision } : item;
  }), userId);
}

function applyOps(ids: number[], ops: BasketOp[]): number[] {
  let next = [...ids];
  for (const op of ops) {
    if (op.type === "clear") next = [];
    else if (typeof op.id === "number" && op.type === "add" && !next.includes(op.id)) next.push(op.id);
    else if (typeof op.id === "number" && op.type === "remove") next = next.filter(id => id !== op.id);
  }
  return next;
}

export function importLegacyBasket(): Promise<void> {
  if (basketPending) return basketPending;
  const userId = activeBasketUser();
  if (!navigator.onLine || !userId || localStorage.getItem(basketImportedKey(userId)) === "1") return Promise.resolve();
  basketPending = (async () => {
    const headers = { "X-V2-Basket-User-ID": String(userId) };
    const response = await fetch("/api/v2/basket/legacy", { cache: "no-store", headers });
    if (!response.ok || activeBasketUser() !== userId) return;
    const legacy = await response.json() as LegacyBasket;
    const before = readV2Basket(userId);
    const opsBefore = JSON.stringify(readBasketOps(userId));
    const ids = applyOps(legacy.product_ids, JSON.parse(opsBefore) as BasketOp[]);
    const imported: BasketProduct[] = [];
    for (const id of ids) {
      if (activeBasketUser() !== userId) return;
      if (before.some(item => item.id === id)) continue;
      const result = await fetch("/api/v2/products/" + id, { cache: "no-store" });
      if (result.status === 404) continue;
      if (!result.ok) throw new Error("Legacy basket product unavailable");
      const product = await result.json() as Product;
      imported.push({ id: product.id, data: product.data, revision: product.revision });
    }
    if (activeBasketUser() !== userId || JSON.stringify(readBasketOps(userId)) !== opsBefore) return;
    const latest = readV2Basket(userId);
    const removedDuringImport = new Set(before.filter(item => !latest.some(current => current.id === item.id)).map(item => item.id));
    const additions = imported.filter(item => !removedDuringImport.has(item.id) && !latest.some(current => current.id === item.id));
    if (additions.length) writeV2Basket([...latest, ...additions], userId);
    const cleared = await fetch("/api/v2/basket/legacy", { method: "DELETE", headers });
    if (!cleared.ok) throw new Error("Legacy basket cleanup failed");
    localStorage.setItem(basketImportedKey(userId), "1");
    localStorage.removeItem(basketOpsKey(userId));
  })().catch(() => { /* Retain old server data for another import attempt. */ })
    .finally(() => { basketPending = null; });
  return basketPending;
}

export function offlineRecipeSummaries(): RecipeSummary[] {
  const value = readJson<unknown>(RECIPES_KEY);
  return Array.isArray(value) ? value as RecipeSummary[] : [];
}

async function run() {
  if ("caches" in window) await caches.delete("price-checker-offline-data-v2");
  if (!navigator.onLine || !window.location.pathname.startsWith("/v2")) return;
  const userId = activeBasketUser();
  const attemptKey = `${ATTEMPT_KEY}:${userId ?? "anon"}`;
  const versionsKey = `${VERSIONS_KEY}:${userId ?? "anon"}`;
  const last = Number(localStorage.getItem(attemptKey) || 0);
  if (Date.now() - last < TEN_MINUTES && localStorage.getItem(CACHE_GENERATION_KEY) === "3") return;
  localStorage.setItem(attemptKey, String(Date.now()));
  const previous = localStorage.getItem(CACHE_GENERATION_KEY) === "3" ? readJson<Versions>(versionsKey) : null;
  const cache = await caches.open(CACHE_NAME);
  const cachedCatalog = await cache.match("/api/v2/products");
  const etag = previous && cachedCatalog && localStorage.getItem(RECIPES_READY_KEY) === "1"
    ? '"u' + (previous.user_id ?? "anon") + '-p' + previous.products + '-r' + previous.recipes + '"' : null;
  const response = await fetch("/api/v2/sync/versions", {
    cache: "no-store", headers: etag ? { "If-None-Match": etag } : undefined,
  });
  if (response.status === 304) return;
  if (!response.ok) throw new Error("Version sync unavailable");
  const versions = await response.json() as Versions;
  if (activeBasketUser() !== userId || versions.user_id !== userId) return;
  if (!previous || previous.recipes !== versions.recipes || localStorage.getItem(RECIPES_READY_KEY) !== "1") await syncRecipes(cache);
  if (!previous || previous.products !== versions.products) await syncProducts(cache, userId);
  if (activeBasketUser() !== userId) return;
  localStorage.setItem(versionsKey, JSON.stringify(versions));
  localStorage.setItem(CACHE_GENERATION_KEY, "3");
  window.dispatchEvent(new Event(SYNC_EVENT));
}

export function syncV2Data() {
  if (!pending) pending = run().catch(() => { /* last good offline data remains intact */ }).finally(() => { pending = null; });
  return pending;
}
