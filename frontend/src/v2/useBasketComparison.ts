import { useMemo, useState } from "react";
import { buildBasketComparison, postalDepartment, presentStoresOff, priceRows, reactivationGains, readingKey, splitSavings, type BasketPrice, type UnitChoices } from "./v2-basket-comparison";
import { snapshotView, type BasketSnapshot } from "./v2-basket-snapshot";
import { basketItemKey, type BasketItem } from "./v2-basket-storage";
import { FIRST_STORES, MORE_STORES } from "./v2-basket-view";
import type { BasketView } from "./useBasketView";
import type { OffStore } from "./V2BasketResults";
import { useSiteFilter } from "./useSiteFilter";

type Display = Pick<BasketView, "filters" | "advanced" | "mode" | "units" | "storesOff">;

/**
 * What the filters offer from the price rows: each store's name, the cities and the departments. The names
 * are shared by every render with the same rows: a page that adds names of its own copies the map first.
 */
function filterOptions(rows: readonly BasketPrice[]): { storeNames: ReadonlyMap<number, string>; cityOptions: string[]; departmentOptions: string[] } {
  const storeNames = new Map<number, string>();
  for (const row of rows) storeNames.set(row.store_id, [row.retailer, row.store_name, row.online ? "En ligne" : row.city].filter(Boolean).join(" · "));
  const cityOptions = [...new Set(rows.map(row => row.city?.trim()).filter((value): value is string => !!value))].sort((a, b) => a.localeCompare(b, "fr"));
  const departmentOptions = [...new Set(rows.map(row => postalDepartment(row.postal_code)).filter((value): value is string => !!value))].sort((a, b) => a.localeCompare(b, "fr"));
  return { storeNames, cityOptions, departmentOptions };
}

/**
 * Everything a basket shows from its prices: the store ranking, the split (without the stores switched
 * off), what each store of the split saves, what each store off would bring back, and the filter options.
 * Computed in the browser from the prices already at hand, for the personal, shared and demo baskets.
 * The account's site-wide filter, when on, replaces the basket's own filters (not in the demo basket,
 * whose stores are fictional).
 */
export function useBasketComparison(snapshot: BasketSnapshot | null, activeItems: readonly BasketItem[], display: Display,
  { siteFilter = true }: { siteFilter?: boolean } = {}) {
  const site = useSiteFilter().active;
  const filters = siteFilter && site ? site : display.filters;
  const { advanced, mode } = display;
  const unitChoices = useMemo<UnitChoices>(() => item => display.units[basketItemKey(item)], [display.units]);
  const storesOff = useMemo(() => new Set(display.storesOff), [display.storesOff]);
  const view = useMemo(() => snapshotView(snapshot, activeItems), [snapshot, activeItems]);
  const rows = useMemo(() => priceRows(view.responses), [view]);
  const comparison = useMemo(() => view.lines.length
    ? buildBasketComparison(view.lines, view.responses, filters, advanced, new Set(), mode, unitChoices) : null, [view, filters, advanced, mode, unitChoices]);
  // The split leaves out the stores switched off; the store ranking does not. Only the stores of this
  // basket's prices matter: one saved for another basket changes nothing here.
  const presentOff = useMemo(() => presentStoresOff(storesOff, rows), [storesOff, rows]);
  const split = useMemo(() => comparison && presentOff.size
    ? buildBasketComparison(view.lines, view.responses, filters, advanced, presentOff, mode, unitChoices) : comparison,
  [comparison, presentOff, view, filters, advanced, mode, unitChoices]);
  const savings = useMemo(() => split ? splitSavings(view.lines, view.responses, filters, advanced, split, mode, unitChoices, presentOff) : new Map(),
    [split, view, filters, advanced, mode, unitChoices, presentOff]);
  const gains = useMemo(() => split && presentOff.size ? reactivationGains(view.lines, view.responses, filters, advanced, split, presentOff, mode, unitChoices) : new Map(),
    [split, view, filters, advanced, mode, unitChoices, presentOff]);
  const lineItems = useMemo(() => view.lines.map(line => line.item), [view]);
  const offStores = useMemo(() => display.storesOff.flatMap((key): OffStore[] => {
    const reading = rows.find(row => readingKey(row) === key);
    return reading ? [{ key, reading, gain: gains.get(key) ?? null }] : [];
  }), [display.storesOff, rows, gains]);
  const { storeNames, cityOptions, departmentOptions } = useMemo(() => filterOptions(rows), [rows]);
  const hasOpenPrices = useMemo(() => comparison?.stores.some(store => store.choices.some(choice => choice.reading.source_provider === "open_prices")) ?? false, [comparison]);
  const filterCount = filters.storeIds.length + filters.cities.length + filters.departments.length;
  return { view, comparison, split, savings, lineItems, availableRows: rows, offStores, storeNames, cityOptions, departmentOptions, hasOpenPrices, filterCount };
}

/**
 * How many stores of the ranking are shown: a few at first, more with each "see more", and back to a few
 * when `resetKey` changes (other prices, filters, settings or articles).
 */
export function useShownStores(resetKey: string): [number, () => void] {
  const [shown, setShown] = useState({ key: "", count: FIRST_STORES });
  const count = shown.key === resetKey ? shown.count : FIRST_STORES;
  return [count, () => setShown({ key: resetKey, count: count + MORE_STORES })];
}

/** The stores a filter can offer: those with a price here and those already chosen, by name. */
export function storeOptions(ids: Iterable<number>, extra: readonly number[], sortLabel: (id: number) => string): number[] {
  return [...new Set([...ids, ...extra])].sort((a, b) => sortLabel(a).localeCompare(sortLabel(b), "fr"));
}
