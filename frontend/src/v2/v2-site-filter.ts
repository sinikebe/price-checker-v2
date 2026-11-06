/**
 * The site-wide store filter of an account, kept on this device (pure, so it can be unit-tested). When it
 * is on, every price the site shows is limited to these stores, communes and departments, and the basket
 * filters give way to it. Saving it to the account (the cloud) comes later.
 */
import { matchesBasketFilters, type BasketFilters, type BasketPrice } from "./v2-basket-comparison";

export type SiteFilterStore = { id: number; label: string };
/** A store of the public directory (GET /api/v2/stores), as the filter choices use it. */
export type DirectoryStore = { id: number; name: string; retailer: string; city: string | null; postal_code: string | null; online?: boolean };
export const directoryStoreLabel = (store: DirectoryStore) => [store.retailer, store.name, store.online ? "En ligne" : store.city].filter(Boolean).join(" · ");
export type SiteFilter = { enabled: boolean; stores: SiteFilterStore[]; cities: string[]; departments: string[] };
export const EMPTY_SITE_FILTER: SiteFilter = { enabled: false, stores: [], cities: [], departments: [] };
const LIMITS = { stores: 200, cities: 100, departments: 100 };

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export const siteFilterKey = (userId: number) => `v2:site-filter:${userId}`;

const text = (value: unknown, max: number): value is string => typeof value === "string" && !!value.trim() && value.length <= max;
const unique = <T,>(values: T[], key: (value: T) => string) => values.filter((value, index) => values.findIndex(other => key(other) === key(value)) === index);

/** A stored filter, checked and bounded; anything unreadable gives the empty (off) filter. */
function cleanSiteFilter(value: unknown): SiteFilter {
  if (!value || typeof value !== "object") return EMPTY_SITE_FILTER;
  const raw = value as Record<string, unknown>;
  const list = (field: unknown) => Array.isArray(field) ? field : [];
  const stores = unique(list(raw.stores).filter((store): store is SiteFilterStore => !!store && typeof store === "object"
    && Number.isSafeInteger((store as SiteFilterStore).id) && (store as SiteFilterStore).id > 0 && text((store as SiteFilterStore).label, 200)), store => String(store.id))
    .slice(0, LIMITS.stores).map(store => ({ id: store.id, label: store.label }));
  const cities = unique(list(raw.cities).filter((city): city is string => text(city, 120)).map(city => city.trim()), city => city.toLocaleLowerCase("fr"))
    .slice(0, LIMITS.cities);
  const departments = unique(list(raw.departments).filter((code): code is string => typeof code === "string" && /^(?:[0-9]{2,3}|2A|2B)$/.test(code)), code => code)
    .slice(0, LIMITS.departments);
  return { enabled: raw.enabled === true, stores, cities, departments };
}

export function readSiteFilter(storage: Storage | null, userId: number | null): SiteFilter {
  if (!storage || !userId) return EMPTY_SITE_FILTER;
  try { return cleanSiteFilter(JSON.parse(storage.getItem(siteFilterKey(userId)) ?? "null")); }
  catch { return EMPTY_SITE_FILTER; }
}

/** Keeps the filter on this device (an empty, off filter is stored as nothing). Throws when storage refuses it. */
export function writeSiteFilter(storage: Storage, userId: number, filter: SiteFilter): SiteFilter {
  const clean = cleanSiteFilter(filter);
  if (!clean.enabled && !clean.stores.length && !clean.cities.length && !clean.departments.length) storage.removeItem(siteFilterKey(userId));
  else storage.setItem(siteFilterKey(userId), JSON.stringify(clean));
  return clean;
}

/** The filter's criteria as basket filters, whether it is on or off; null when it names nothing. */
export function siteFilterCriteria(filter: SiteFilter): BasketFilters | null {
  if (!filter.stores.length && !filter.cities.length && !filter.departments.length) return null;
  return { storeIds: filter.stores.map(store => store.id), cities: filter.cities, departments: filter.departments };
}

/** The filters in force across the site, or null when the site filter is off or empty. */
export function activeSiteFilters(filter: SiteFilter): BasketFilters | null {
  return filter.enabled ? siteFilterCriteria(filter) : null;
}

/** Whether two sets of basket filters keep the same stores, whatever their order. */
export function sameBasketFilters(left: BasketFilters, right: BasketFilters): boolean {
  const key = (filters: BasketFilters) => JSON.stringify([
    [...filters.storeIds].sort((a, b) => a - b), [...filters.cities].map(city => city.toLocaleLowerCase("fr")).sort(), [...filters.departments].sort()]);
  return key(left) === key(right);
}

/** Whether a price reading passes the site filter (online platforms pass the commune and department filters). */
export function passesSiteFilter(row: Pick<BasketPrice, "store_id" | "city" | "postal_code" | "online">, filters: BasketFilters | null): boolean {
  return !filters || matchesBasketFilters(row as BasketPrice, filters);
}

/** One line describing the filter: "3 magasins · 2 communes · département 78". */
export function siteFilterSummary(filter: SiteFilter): string {
  return basketFiltersSummary({ storeIds: filter.stores.map(store => store.id), cities: filter.cities, departments: filter.departments });
}

/** The same line for a basket's filters (a shared basket's, for instance). */
export function basketFiltersSummary(filter: BasketFilters): string {
  const parts = [
    filter.storeIds.length ? `${filter.storeIds.length} magasin${filter.storeIds.length > 1 ? "s" : ""}` : null,
    filter.cities.length ? `${filter.cities.length} commune${filter.cities.length > 1 ? "s" : ""}` : null,
    filter.departments.length ? `département${filter.departments.length > 1 ? "s" : ""} ${filter.departments.join(", ")}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "aucun critère";
}
