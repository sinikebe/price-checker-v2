import type { BasketItem, BasketProduct } from "./v2-basket-storage";

export type BasketPrice = {
  id: number; price: string; observed_at: string; retailer: string; store_name: string;
  store_id: number; city: string | null; postal_code: string | null;
  sales_channel: "in_store" | "drive" | "delivery";
  available: boolean; correction_status: string | null; source_provider: string | null;
};
export type BasketPriceResponse = { latest_by_store: BasketPrice[]; stores_truncated: boolean };
export type BasketLine = { item: BasketItem; candidates: BasketProduct[] };
export type BasketFilters = { storeIds: number[]; cities: string[]; departments: string[] };
export type PriceChoice = { item: BasketItem; product: BasketProduct; reading: BasketPrice; cents: number };
export type StoreQuote = { key: string; reading: BasketPrice; choices: PriceChoice[]; cents: number; coverage: number };
export type BasketComparison = {
  stores: StoreQuote[]; split: PriceChoice[]; splitCents: number;
  missing: BasketItem[]; failed: BasketItem[]; truncated: BasketItem[];
};
export type PricePosition = "neutral" | "low" | "middle" | "high";
export function pricePosition(cents: number, min: number, max: number): PricePosition {
  if (!Number.isFinite(cents) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return "neutral";
  const fraction = (cents - min) / (max - min);
  if (fraction <= 1 / 3) return "low";
  if (fraction <= 2 / 3) return "middle";
  return "high";
}
export const emptyBasketFilters: BasketFilters = { storeIds: [], cities: [], departments: [] };
const storeKey = (row: BasketPrice) => String(row.store_id) + ":" + row.sales_channel;
const fold = (value: string) => value.trim().toLocaleLowerCase("fr");

// French postal codes include Corsica and overseas departments.
export function postalDepartment(postalCode: string | null): string | null {
  const code = postalCode?.trim() ?? "";
  if (!/^\d{5}$/.test(code)) return null;
  if (/^97[1-6]|^98[4-9]/.test(code)) return code.slice(0, 3);
  if (code.startsWith("20")) return Number(code.slice(0, 3)) <= 201 ? "2A" : "2B";
  return code.slice(0, 2);
}
export function matchesBasketFilters(row: BasketPrice, filters: BasketFilters): boolean {
  return (!filters.storeIds.length || filters.storeIds.includes(row.store_id))
    && (!filters.cities.length || filters.cities.some(city => fold(city) === fold(row.city ?? "")))
    && (!filters.departments.length || filters.departments.includes(postalDepartment(row.postal_code) ?? ""));
}
function validPrice(row: BasketPrice): number | null {
  const value = Number(row.price);
  if (!row.available || row.correction_status === "active" || !Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}
function cheaper(left: PriceChoice, right: PriceChoice) {
  return left.cents - right.cents
    || right.reading.observed_at.localeCompare(left.reading.observed_at)
    || left.reading.store_id - right.reading.store_id
    || left.reading.sales_channel.localeCompare(right.reading.sales_channel)
    || left.product.id - right.product.id;
}
export function buildBasketComparison(
  lines: BasketLine[], responses: Map<number, BasketPriceResponse | null>,
  filters: BasketFilters = emptyBasketFilters,
): BasketComparison {
  const stores = new Map<string, StoreQuote>();
  const split: PriceChoice[] = [], missing: BasketItem[] = [], failed: BasketItem[] = [], truncated: BasketItem[] = [];
  for (const line of lines) {
    const products = [...new Map(line.candidates.map(product => [product.id, product])).values()];
    if (!products.length || products.some(product => !responses.get(product.id))) {
      failed.push(line.item); missing.push(line.item); continue;
    }
    if (products.some(product => responses.get(product.id)?.stores_truncated)) truncated.push(line.item);
    const byStore = new Map<string, PriceChoice>();
    for (const product of products) for (const reading of responses.get(product.id)!.latest_by_store) {
      const cents = validPrice(reading);
      if (cents === null || !matchesBasketFilters(reading, filters)) continue;
      const choice = { item: line.item, product, reading, cents };
      const key = storeKey(reading), current = byStore.get(key);
      if (!current || cheaper(choice, current) < 0) byStore.set(key, choice);
    }
    const choices = [...byStore.values()].sort(cheaper);
    if (choices.length) split.push(choices[0]);
    else missing.push(line.item);
    for (const [key, choice] of byStore) {
      let store = stores.get(key);
      if (!store) {
        store = { key, reading: choice.reading, choices: [], cents: 0, coverage: 0 };
        stores.set(key, store);
      }
      store.choices.push(choice); store.cents += choice.cents; store.coverage += 1;
    }
  }
  const storeList = [...stores.values()].sort((left, right) => {
    const leftComplete = left.coverage === lines.length, rightComplete = right.coverage === lines.length;
    if (leftComplete !== rightComplete) return leftComplete ? -1 : 1;
    if (!leftComplete && left.coverage !== right.coverage) return right.coverage - left.coverage;
    return left.cents - right.cents || left.reading.store_name.localeCompare(right.reading.store_name, "fr");
  });
  return { stores: storeList, split, splitCents: split.reduce((sum, choice) => sum + choice.cents, 0), missing, failed, truncated };
}
