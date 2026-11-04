import { useMemo } from "react";
import { buildBasketComparison, postalDepartment, reactivationGains, readingKey, splitSavings, type UnitChoices } from "./v2-basket-comparison";
import { snapshotView, type BasketSnapshot } from "./v2-basket-snapshot";
import { basketItemKey, type BasketItem } from "./v2-basket-storage";
import type { BasketView } from "./useBasketView";
import type { OffStore } from "./V2BasketResults";

type Display = Pick<BasketView, "filters" | "advanced" | "mode" | "units" | "storesOff">;

/**
 * Everything a basket shows from its prices: the store ranking, the split (without the stores switched
 * off), what each store of the split saves, what each store off would bring back, and the filter options.
 * Computed in the browser from the prices already at hand, for the personal, shared and demo baskets.
 */
export function useBasketComparison(snapshot: BasketSnapshot | null, activeItems: readonly BasketItem[], display: Display) {
  const { filters, advanced, mode } = display;
  const unitChoices = useMemo<UnitChoices>(() => item => display.units[basketItemKey(item)], [display.units]);
  const storesOff = useMemo(() => new Set(display.storesOff), [display.storesOff]);
  const view = useMemo(() => snapshotView(snapshot, activeItems), [snapshot, activeItems]);
  const comparison = useMemo(() => view.lines.length
    ? buildBasketComparison(view.lines, view.responses, filters, advanced, new Set(), mode, unitChoices) : null, [view, filters, advanced, mode, unitChoices]);
  // The split leaves out the stores switched off; the store ranking does not. Only the stores of this
  // basket's prices matter: one saved for another basket changes nothing here.
  const presentOff = useMemo(() => new Set([...storesOff].filter(key => [...view.responses.values()]
    .some(response => response?.latest_by_store.some(row => readingKey(row) === key)))), [storesOff, view]);
  const split = useMemo(() => comparison && presentOff.size
    ? buildBasketComparison(view.lines, view.responses, filters, advanced, presentOff, mode, unitChoices) : comparison,
  [comparison, presentOff, view, filters, advanced, mode, unitChoices]);
  const savings = useMemo(() => split ? splitSavings(view.lines, view.responses, filters, advanced, split, mode, unitChoices, presentOff) : new Map(),
    [split, view, filters, advanced, mode, unitChoices, presentOff]);
  const gains = useMemo(() => split && presentOff.size ? reactivationGains(view.lines, view.responses, filters, advanced, split, presentOff, mode, unitChoices) : new Map(),
    [split, view, filters, advanced, mode, unitChoices, presentOff]);
  const lineItems = view.lines.map(line => line.item);
  const availableRows = [...view.responses.values()].flatMap(response => response?.latest_by_store ?? []);
  const offStores: OffStore[] = display.storesOff.flatMap(key => {
    const reading = availableRows.find(row => readingKey(row) === key);
    return reading ? [{ key, reading, gain: gains.get(key) ?? null }] : [];
  });
  const storeNames = new Map<number, string>();
  for (const row of availableRows) storeNames.set(row.store_id, [row.retailer, row.store_name, row.online ? "En ligne" : row.city].filter(Boolean).join(" · "));
  const cityOptions = [...new Set(availableRows.map(row => row.city?.trim()).filter((value): value is string => !!value))].sort((a, b) => a.localeCompare(b, "fr"));
  const departmentOptions = [...new Set(availableRows.map(row => postalDepartment(row.postal_code)).filter((value): value is string => !!value))].sort((a, b) => a.localeCompare(b, "fr"));
  const hasOpenPrices = comparison?.stores.some(store => store.choices.some(choice => choice.reading.source_provider === "open_prices")) ?? false;
  const filterCount = filters.storeIds.length + filters.cities.length + filters.departments.length;
  return { view, comparison, split, savings, lineItems, availableRows, offStores, storeNames, cityOptions, departmentOptions, hasOpenPrices, filterCount };
}
