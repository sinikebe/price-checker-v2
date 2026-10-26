import { activeBasketUser, basketOpsKey, readBasketOps, readV2Basket, writeV2Basket, type BasketOp } from "../v2/v2-basket-storage";
import type { Product } from "../v2/v2-products-api";
import type { Recipe, RecipeSummary } from "../v2/v2-recipes-api";

const TEN_MINUTES = 10 * 60 * 1000;
const ATTEMPT_KEY = "v2:pwa:sync-attempt";
const VERSIONS_KEY = "v2:pwa:versions";
const RECIPES_KEY = "v2:pwa:recipe-summaries";
const RECIPES_READY_KEY = "v2:pwa:recipe-summaries-ready";
const CACHE_NAME = "price-checker-offline-data-v2";
export const SYNC_EVENT = "v2-pwa-data-synced";
type Versions = { products: number; recipes: number; basket: number; user_id: number | null };
type ServerBasket = { product_ids: number[]; revision: number };
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

async function syncBasket(userId: number, cache: Cache): Promise<number> {
  const stillCurrent = () => {
    if (activeBasketUser() !== userId) throw new Error("Basket account changed during sync");
  };
  const identityHeaders = { "X-V2-Basket-User-ID": String(userId) };
  stillCurrent();
  const withdrawn = await withdrawnProducts();
  const initialOps = JSON.stringify(readBasketOps(userId));
  const ops: BasketOp[] = (JSON.parse(initialOps) as BasketOp[])
    .filter(op => op.type !== "add" || typeof op.id !== "number" || !withdrawn.has(op.id));
  for (let attempt = 0; attempt < 3; attempt++) {
    stillCurrent();
    const remoteResponse = await fetch("/api/v2/basket", { cache: "no-store", headers: identityHeaders });
    if (!remoteResponse.ok) throw new Error("Basket sync unavailable");
    const remote = await remoteResponse.json() as ServerBasket;
    stillCurrent();
    const ids = applyOps(remote.product_ids.filter(id => !withdrawn.has(id)), ops);
    let revision = remote.revision;
    if (JSON.stringify(ids) !== JSON.stringify(remote.product_ids)) {
      const saved = await fetch("/api/v2/basket", {
        method: "PUT", headers: { "Content-Type": "application/json", ...identityHeaders },
        body: JSON.stringify({ product_ids: ids, revision: remote.revision }),
      });
      stillCurrent();
      if (saved.status === 409) continue;
      if (!saved.ok) throw new Error("Basket sync failed");
      revision = (await saved.json() as ServerBasket).revision;
      stillCurrent();
    }
    const catalogResponse = await cache.match("/api/v2/products");
    const catalog: Product[] = catalogResponse ? await catalogResponse.json() : [];
    const byId = new Map(catalog.map(product => [product.id, product]));
    const remoteProducts = new Map<number, Product>();
    for (const id of ids) {
      stillCurrent();
      const product = byId.get(id) ?? await fresh<Product>("/api/v2/products/" + id, cache);
      remoteProducts.set(id, product);
    }
    stillCurrent();
    // Re-read operations and local products after every await, then commit synchronously.
    const latestOps = readBasketOps(userId);
    const remaining = JSON.stringify(latestOps.slice(0, ops.length)) === initialOps
      ? latestOps.slice(ops.length) : latestOps;
    const displayIds = applyOps(ids, remaining).filter(id => !withdrawn.has(id));
    const local = new Map(readV2Basket(userId).map(product => [product.id, product]));
    const products = displayIds.map(id => {
      const product = byId.get(id) ?? local.get(id) ?? remoteProducts.get(id);
      if (!product) throw new Error("Basket product unavailable");
      return { id, data: product.data, revision: product.revision };
    });
    writeV2Basket(products, userId);
    if (remaining.length) localStorage.setItem(basketOpsKey(userId), JSON.stringify(remaining));
    else localStorage.removeItem(basketOpsKey(userId));
    return revision;
  }
  throw new Error("Basket changed concurrently");
}

export function offlineRecipeSummaries(): RecipeSummary[] {
  const value = readJson<unknown>(RECIPES_KEY);
  return Array.isArray(value) ? value as RecipeSummary[] : [];
}

async function run() {
  if (!navigator.onLine || !window.location.pathname.startsWith("/v2")) return;
  const userId = activeBasketUser();
  const attemptKey = `${ATTEMPT_KEY}:${userId ?? "anon"}`;
  const versionsKey = `${VERSIONS_KEY}:${userId ?? "anon"}`;
  const last = Number(localStorage.getItem(attemptKey) || 0);
  if (Date.now() - last < TEN_MINUTES) return;
  localStorage.setItem(attemptKey, String(Date.now()));
  const previous = readJson<Versions>(versionsKey);
  const cache = await caches.open(CACHE_NAME);
  const cachedCatalog = await cache.match("/api/v2/products");
  const etag = previous && cachedCatalog && localStorage.getItem(RECIPES_READY_KEY) === "1"
    ? `"u${previous.user_id ?? "anon"}-p${previous.products}-r${previous.recipes}-b${previous.basket}"` : null;
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
  if (userId && (!previous || previous.basket !== versions.basket || readBasketOps(userId).length)) versions.basket = await syncBasket(userId, cache);
  if (activeBasketUser() !== userId) return;
  localStorage.setItem(versionsKey, JSON.stringify(versions));
  window.dispatchEvent(new Event(SYNC_EVENT));
}

export function syncV2Data() {
  if (!pending) pending = run().catch(() => { /* last good offline data remains intact */ }).finally(() => { pending = null; });
  return pending;
}

export function flushV2BasketOps() {
  if (basketPending) return basketPending;
  const userId = activeBasketUser();
  if (!navigator.onLine || !userId || !readBasketOps(userId).length) return Promise.resolve();
  let succeeded = false;
  basketPending = (async () => {
    if (pending) await pending;
    if (activeBasketUser() !== userId || !readBasketOps(userId).length) return;
    const cache = await caches.open(CACHE_NAME);
    const revision = await syncBasket(userId, cache);
    succeeded = true;
    const key = `${VERSIONS_KEY}:${userId}`;
    const versions = readJson<Versions>(key);
    if (versions) localStorage.setItem(key, JSON.stringify({ ...versions, basket: revision }));
  })().catch(() => { /* retain unsent local operations */ }).finally(() => { basketPending = null; if (succeeded && readBasketOps(userId).length) void flushV2BasketOps(); });
  return basketPending;
}
