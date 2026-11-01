/**
 * Pure core of the catalogue search (no React): how a text matches a product, which complete lists
 * can answer a longer text without asking the server again, and what the page shows.
 *
 * The matching rule is the server's (backend/app/api/v2/catalogue.py, SEARCH_TEXT). The shared fixture
 * frontend/tests/fixtures/search-parity.json keeps both in agreement.
 */

/** Fewer characters match too much to be worth a request. */
export const SEARCH_MIN_CHARS = 2;
/** Wait for a pause in the typing before asking the server. */
export const SEARCH_DEBOUNCE_MS = 350;
/** Complete lists kept to answer later texts locally. */
export const SEARCH_CACHE_SIZE = 24;
/** The longest text the server accepts. */
export const SEARCH_MAX_LENGTH = 120;

export type SearchableProduct = {
  data: { brand?: string | null; name?: string | null; commercial_name?: string | null; quantity?: string | null; ean?: string | null };
};
export type SearchScope = { category: string; storeId: number };

const SPACES = /[ \t\n\r\f\v]+/g;
/** Runs of spaces become one and the ends are trimmed: an empty field must not change what a phrase matches. */
export const collapse = (text: string): string => text.replace(SPACES, " ").trim();
/** The form of a text used to compare: collapsed, lower case. */
export const normalizeQuery = (text: string): string => collapse(text).toLocaleLowerCase("fr");

/** The text searched in a product: its fields joined with one space, the absent ones skipped. */
export function searchText(product: SearchableProduct): string {
  const { brand, name, commercial_name, quantity, ean } = product.data;
  return normalizeQuery([brand, name, commercial_name, quantity, ean].filter(part => part != null).join(" "));
}

export function matchesQuery(product: SearchableProduct, query: string): boolean {
  const wanted = normalizeQuery(query);
  return wanted === "" || searchText(product).includes(wanted);
}

export function filterProducts<T extends SearchableProduct>(items: readonly T[], query: string): T[] {
  const wanted = normalizeQuery(query);
  return wanted === "" ? [...items] : items.filter(item => searchText(item).includes(wanted));
}

/** Eight, twelve, thirteen or fourteen digits: a barcode (EAN-8, UPC-A, EAN-13, GTIN-14). */
export const isBarcode = (text: string): boolean => /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(text.trim());

/** The same barcode written with or without its leading zeros. */
export const sameBarcode = (a: string, b: string): boolean => a.padStart(14, "0") === b.padStart(14, "0");

export const scopeKey = (scope: SearchScope): string => `${scope.category.trim().toLocaleLowerCase("fr")}|${scope.storeId}`;

/** Every product matching `query` within `scope`, as the server listed them (it had few enough to send). */
export type CompleteList<T> = { query: string; scope: SearchScope; items: T[] };

/**
 * A text containing an earlier one matches a subset of what the earlier one matched, so the list
 * kept for the earlier text can be filtered instead of asking again. Returns the smallest such list.
 */
export function findCovering<T>(cache: readonly CompleteList<T>[], query: string, scope: SearchScope): CompleteList<T> | null {
  const wanted = normalizeQuery(query);
  if (wanted.length < SEARCH_MIN_CHARS) return null;
  const key = scopeKey(scope);
  let best: CompleteList<T> | null = null;
  for (const entry of cache) {
    if (scopeKey(entry.scope) !== key || !wanted.includes(entry.query)) continue;
    if (!best || entry.items.length < best.items.length
      || (entry.items.length === best.items.length && entry.query.length > best.query.length)) best = entry;
  }
  return best;
}

/** The cache with a new list added (replacing the same search) and the oldest dropped beyond the size. */
export function remember<T>(cache: readonly CompleteList<T>[], entry: CompleteList<T>, size = SEARCH_CACHE_SIZE): CompleteList<T>[] {
  const key = scopeKey(entry.scope);
  const rest = cache.filter(item => !(item.query === entry.query && scopeKey(item.scope) === key));
  return [...rest, entry].slice(-size);
}

export type SearchOutcome =
  | { kind: "many"; total: number; max: number }
  | { kind: "error"; message: string };

export type SearchView<T> =
  | { kind: "idle"; short: boolean }
  | { kind: "loading" }
  | { kind: "list"; items: T[]; local: boolean }
  | { kind: "many"; total: number; max: number }
  | { kind: "limited"; retryAfter: number }
  | { kind: "error"; message: string };

/** What the page shows for the text typed, from what is already known. A "loading" view means a request is due. */
export function resolveView<T extends SearchableProduct>(input: {
  query: string; scope: SearchScope; cache: readonly CompleteList<T>[];
  /** The answer of the server for exactly this search, if any. */
  outcome: SearchOutcome | null;
  /** Set while the server is refusing requests: seconds to wait. */
  limitedFor: number | null;
}): SearchView<T> {
  const wanted = normalizeQuery(input.query);
  if (wanted.length < SEARCH_MIN_CHARS) return { kind: "idle", short: wanted.length > 0 };
  const covering = findCovering(input.cache, wanted, input.scope);
  if (covering) return { kind: "list", items: filterProducts(covering.items, wanted), local: true };
  if (input.limitedFor !== null) return { kind: "limited", retryAfter: input.limitedFor };
  if (input.outcome) return input.outcome;
  return { kind: "loading" };
}
