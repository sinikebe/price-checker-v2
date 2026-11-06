import { basketItemKey, type BasketItem, type BasketProduct } from "./v2-basket-storage";
import type { BasketLine, BasketPriceResponse } from "./v2-basket-comparison";
import type { BasketFetchResult } from "./v2-basket-credits-api";

/** The prices fetched for a basket. Everything the comparison needs is kept, so filters, quantities and
 *  excluded articles are recomputed here without another request. */
export type BasketSnapshot = {
  userId: number;
  /** Set on the view built from a shared basket's prices (sharedSnapshot); never stored by this module. */
  basketId?: number;
  fetchedAt: string;
  entries: Record<string, { productIds: number[]; truncated: boolean }>;
  products: Record<string, BasketProduct>;
  prices: Record<string, BasketPriceResponse>;
};

export function snapshotFromFetch(userId: number, items: readonly BasketItem[], result: BasketFetchResult): BasketSnapshot {
  if (result.lines.length !== items.length) throw new Error("Réponse inattendue du serveur.");
  const entries: BasketSnapshot["entries"] = {};
  items.forEach((item, index) => {
    entries[basketItemKey(item)] = { productIds: result.lines[index].product_ids, truncated: result.lines[index].truncated };
  });
  return { userId, fetchedAt: result.fetched_at, entries, products: result.products, prices: result.prices };
}

export type SnapshotView = {
  lines: BasketLine[];
  responses: Map<number, BasketPriceResponse | null>;
  /** Active articles the snapshot knows nothing about (added or changed since). */
  stale: BasketItem[];
  /** Articles whose candidates were cut by the size limit of one fetch. */
  limited: BasketItem[];
};

/** A product known only by its barcode has no name on the server: the basket line's own name stands in. */
function named(product: BasketProduct, item: BasketItem): BasketProduct {
  if (product.data.name || "kind" in item || item.id !== product.id) return product;
  return { ...product, data: { ...product.data, name: item.data.name, brand: product.data.brand || item.data.brand, quantity: product.data.quantity || item.data.quantity } };
}

export function snapshotView(snapshot: BasketSnapshot | null, activeItems: readonly BasketItem[]): SnapshotView {
  const lines: BasketLine[] = [], stale: BasketItem[] = [], limited: BasketItem[] = [];
  const responses = new Map<number, BasketPriceResponse | null>();
  for (const item of activeItems) {
    const entry = snapshot?.entries[basketItemKey(item)];
    if (!snapshot || !entry) { stale.push(item); continue; }
    const candidates = entry.productIds.flatMap(id => snapshot.products[id] ? [named(snapshot.products[id], item)] : []);
    lines.push({ item, candidates });
    if (entry.truncated) limited.push(item);
    for (const product of candidates) responses.set(product.id, snapshot.prices[product.id] ?? null);
  }
  return { lines, responses, stale, limited };
}

/**
 * The last result of the personal basket, one per account. The key ends with the account id, so the
 * account's local data is found by it. A shared basket's prices are kept by v2-shared-basket.ts (sharedPricesKey).
 */
export const snapshotKey = (userId: number) => `v2:basket:prices:${userId}`;
const MAX_STORED_CHARACTERS = 3_000_000;
const memory = new Map<string, BasketSnapshot>();

function plausible(value: unknown, userId: number): value is BasketSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as BasketSnapshot;
  // A value carrying a basket is a shared basket's view, never the personal result.
  return (snapshot.basketId ?? null) === null && snapshot.userId === userId && typeof snapshot.fetchedAt === "string"
    && !!snapshot.entries && typeof snapshot.entries === "object"
    && !!snapshot.products && typeof snapshot.products === "object"
    && !!snapshot.prices && typeof snapshot.prices === "object";
}
export function readSnapshot(userId: number): BasketSnapshot | null {
  const kept = memory.get(snapshotKey(userId));
  if (kept) return kept;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(snapshotKey(userId)) ?? "null");
    return plausible(value, userId) ? value : null;
  } catch { return null; }
}
/** Kept for this session, and in the browser when it fits, so the page opens on the last result. */
export function writeSnapshot(snapshot: BasketSnapshot) {
  if (snapshot.basketId !== undefined) return; // a shared basket's prices are kept by writeSharedPrices
  const key = snapshotKey(snapshot.userId);
  memory.set(key, snapshot);
  try {
    const text = JSON.stringify(snapshot);
    if (text.length <= MAX_STORED_CHARACTERS) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch { /* the session copy still works */ }
}
export function forgetSnapshot(userId: number) {
  memory.delete(snapshotKey(userId));
  try { localStorage.removeItem(snapshotKey(userId)); } catch { /* nothing stored */ }
}
