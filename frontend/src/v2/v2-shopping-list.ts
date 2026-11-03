/**
 * The shopping list of a basket, from the prices already fetched (no request, no credit). No value
 * import, so the tests can load this file on its own.
 */
import type { BasketComparison, BasketPrice, PriceChoice } from "./v2-basket-comparison";
import type { BasketItem } from "./v2-basket-storage";

type KeyOf = (item: BasketItem) => string;
export type ListLine = { key: string; item: BasketItem; choice: PriceChoice | null };
/** One store: what to buy there, and (first on the list) what it has no price for. */
export type ListSection = { key: string; reading: BasketPrice; lines: ListLine[]; missing: ListLine[]; cents: number };

const storeKey = (reading: BasketPrice) => reading.store_id + ":" + reading.sales_channel;
const line = (choice: PriceChoice, keyOf: KeyOf): ListLine => ({ key: keyOf(choice.item), item: choice.item, choice });

/**
 * The whole basket at one store (a store card of the ranking). The articles it has no price for come
 * first: the shopper can look for an alternative on the spot and see its price.
 */
export function storeList(comparison: BasketComparison, items: readonly BasketItem[], key: string, keyOf: KeyOf): ListSection | null {
  const store = comparison.stores.find(candidate => candidate.key === key);
  if (!store) return null;
  const priced = new Set(store.choices.map(choice => keyOf(choice.item)));
  return {
    key, reading: store.reading, cents: store.cents,
    lines: store.choices.map(choice => line(choice, keyOf)),
    missing: items.filter(item => !priced.has(keyOf(item))).map(item => ({ key: keyOf(item), item, choice: null })),
  };
}

/** The split across stores, one section per store, the biggest share first; and what no store prices. */
export function splitList(split: BasketComparison, items: readonly BasketItem[], keyOf: KeyOf): { sections: ListSection[]; unpriced: ListLine[] } {
  const sections = new Map<string, ListSection>();
  for (const choice of split.split) {
    const key = storeKey(choice.reading);
    const section = sections.get(key) ?? { key, reading: choice.reading, lines: [], missing: [], cents: 0 };
    section.lines.push(line(choice, keyOf));
    section.cents += choice.cents;
    sections.set(key, section);
  }
  const placed = new Set(split.split.map(choice => keyOf(choice.item)));
  return {
    sections: [...sections.values()].sort((a, b) => b.lines.length - a.lines.length || b.cents - a.cents
      || a.reading.retailer.localeCompare(b.reading.retailer, "fr")),
    unpriced: items.filter(item => !placed.has(keyOf(item))).map(item => ({ key: keyOf(item), item, choice: null })),
  };
}

/** The part of the split bought at one store (a store row of the split). */
export function splitStoreList(split: BasketComparison, key: string, keyOf: KeyOf): ListSection | null {
  return splitList(split, [], keyOf).sections.find(section => section.key === key) ?? null;
}

/** Ticking or unticking an article; ticks of articles no longer in the basket are dropped. */
export function withChecked(checked: readonly string[], key: string, on: boolean, keep: Iterable<string>): string[] {
  const kept = new Set(keep);
  const next = checked.filter(value => value !== key && kept.has(value));
  if (on && kept.has(key)) next.push(key);
  return next.slice(0, 100);
}

/** The address of the shopping list, for the whole split or one store (`repartition`: only its share of the split). */
export function shoppingListPath(basketPath: string, store?: { key: string; split?: boolean }): string {
  if (!store) return basketPath + "/liste";
  const query = new URLSearchParams({ magasin: store.key, ...(store.split ? { repartition: "1" } : {}) });
  return `${basketPath}/liste?${query.toString()}`;
}

/** The store asked for by the list address, when it is a store and sales channel key. */
export function listStore(search: string): { key: string; split: boolean } | null {
  const query = new URLSearchParams(search);
  const key = query.get("magasin") ?? "";
  return /^[1-9][0-9]{0,18}:(?:in_store|drive|delivery)$/.test(key) ? { key, split: query.get("repartition") === "1" } : null;
}
