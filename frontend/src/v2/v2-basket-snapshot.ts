import { basketItemKey, type BasketItem, type BasketProduct } from "./v2-basket-storage";
import type { BasketLine, BasketPriceResponse } from "./v2-basket-comparison";
import type { BasketFetchResult } from "./v2-basket-credits-api";

/** The prices fetched for a basket. Everything the comparison needs is kept, so filters, quantities and
 *  excluded articles are recomputed here without another request. */
export type BasketSnapshot = {
  userId: number;
  /** The shared basket these prices are for; absent for the personal basket. */
  basketId?: number;
  fetchedAt: string;
  entries: Record<string, { productIds: number[]; truncated: boolean }>;
  products: Record<string, BasketProduct>;
  prices: Record<string, BasketPriceResponse>;
};

export function snapshotFromFetch(userId: number, items: readonly BasketItem[], result: BasketFetchResult, basketId?: number): BasketSnapshot {
  if (result.lines.length !== items.length) throw new Error("Réponse inattendue du serveur.");
  const entries: BasketSnapshot["entries"] = {};
  items.forEach((item, index) => {
    entries[basketItemKey(item)] = { productIds: result.lines[index].product_ids, truncated: result.lines[index].truncated };
  });
  return { userId, ...(basketId ? { basketId } : {}), fetchedAt: result.fetched_at, entries, products: result.products, prices: result.prices };
}

export type SnapshotView = {
  lines: BasketLine[];
  responses: Map<number, BasketPriceResponse | null>;
  /** Active articles the snapshot knows nothing about (added or changed since). */
  stale: BasketItem[];
  /** Articles whose candidates were cut by the size limit of one fetch. */
  limited: BasketItem[];
};

export function snapshotView(snapshot: BasketSnapshot | null, activeItems: readonly BasketItem[]): SnapshotView {
  const lines: BasketLine[] = [], stale: BasketItem[] = [], limited: BasketItem[] = [];
  const responses = new Map<number, BasketPriceResponse | null>();
  for (const item of activeItems) {
    const entry = snapshot?.entries[basketItemKey(item)];
    if (!snapshot || !entry) { stale.push(item); continue; }
    const candidates = entry.productIds.flatMap(id => snapshot.products[id] ? [snapshot.products[id]] : []);
    lines.push({ item, candidates });
    if (entry.truncated) limited.push(item);
    for (const product of candidates) responses.set(product.id, snapshot.prices[product.id] ?? null);
  }
  return { lines, responses, stale, limited };
}

/** One stored result per account and basket. The key ends with the account id, so the account's local data is found by it. */
export const snapshotKey = (userId: number, basketId?: number) => basketId ? `v2:basket:shared-prices:${basketId}:${userId}` : `v2:basket:prices:${userId}`;
const MAX_STORED_CHARACTERS = 3_000_000;
const memory = new Map<string, BasketSnapshot>();

function plausible(value: unknown, userId: number, basketId?: number): value is BasketSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as BasketSnapshot;
  return snapshot.userId === userId && (snapshot.basketId ?? null) === (basketId ?? null) && typeof snapshot.fetchedAt === "string"
    && !!snapshot.entries && typeof snapshot.entries === "object"
    && !!snapshot.products && typeof snapshot.products === "object"
    && !!snapshot.prices && typeof snapshot.prices === "object";
}
export function readSnapshot(userId: number, basketId?: number): BasketSnapshot | null {
  const kept = memory.get(snapshotKey(userId, basketId));
  if (kept) return kept;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(snapshotKey(userId, basketId)) ?? "null");
    return plausible(value, userId, basketId) ? value : null;
  } catch { return null; }
}
/** Kept for this session, and in the browser when it fits, so the page opens on the last result. */
export function writeSnapshot(snapshot: BasketSnapshot) {
  const key = snapshotKey(snapshot.userId, snapshot.basketId);
  memory.set(key, snapshot);
  try {
    const text = JSON.stringify(snapshot);
    if (text.length <= MAX_STORED_CHARACTERS) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch { /* the session copy still works */ }
}
export function forgetSnapshot(userId: number, basketId?: number) {
  memory.delete(snapshotKey(userId, basketId));
  try { localStorage.removeItem(snapshotKey(userId, basketId)); } catch { /* nothing stored */ }
}
