import type { BasketItem, BasketProduct } from "./v2-basket-storage";
import { baseQuantity, microUnits, pricedQuantity, productSizeIn, productSizes, purchaseDemand, type BaseUnit } from "./v2-basket-quantity";

export type BasketPrice = {
  id: number; price: string; observed_at: string; retailer: string; store_name: string;
  store_id: number; city: string | null; postal_code: string | null;
  sales_channel: "in_store" | "drive" | "delivery";
  available: boolean; correction_status: string | null; source_provider: string | null;
};
export type BasketPriceResponse = { latest_by_store: BasketPrice[]; stores_truncated: boolean; withdrawn_count?: number };
export type BasketLine = { item: BasketItem; candidates: BasketProduct[] };
export type BasketFilters = { storeIds: number[]; cities: string[]; departments: string[] };
/** "price": the least to pay for what is needed. "unit": the best price per kg, L or piece, even in a bigger pack. */
export type CompareMode = "price" | "unit";
/**
 * What a choice costs per base unit (a gram, a millilitre, a piece), and what is left once the need is covered.
 * `available` lists the units the article can be compared in (those its candidates are measured in), and `fixed`
 * tells that the requested quantity sets the unit, so it cannot be switched.
 */
export type UnitInfo = { perUnitCents: number; unit: BaseUnit; surplus: number; available: BaseUnit[]; fixed: boolean };
/** The unit chosen for an article, when it can be compared in several (none: the default one). */
export type UnitChoices = (item: BasketItem) => BaseUnit | undefined;
const noChoice: UnitChoices = () => undefined;
export type PriceChoice = {
  item: BasketItem; product: BasketProduct; reading: BasketPrice; cents: number; packages: number; usedCents: number; used: boolean;
  unit?: UnitInfo; demand?: { demand: bigint; capacity: bigint };
};
export type StoreQuote = { key: string; reading: BasketPrice; choices: PriceChoice[]; cents: number; usedCents: number; coverage: number };
export type BasketComparison = {
  stores: StoreQuote[]; split: PriceChoice[]; splitCents: number; splitUsedCents: number;
  missing: BasketItem[]; failed: BasketItem[]; truncated: BasketItem[];
  /** Prices the server left out because the product is withdrawn at that store. */
  withdrawn: number;
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
/** Identifies a store and sales channel, as a row of the split or of the store ranking. */
export const readingKey = storeKey;
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
    || left.usedCents - right.usedCents
    || right.reading.observed_at.localeCompare(left.reading.observed_at)
    || left.reading.store_id - right.reading.store_id
    || left.reading.sales_channel.localeCompare(right.reading.sales_channel)
    || left.product.id - right.product.id;
}
// Total cash outlay for the concrete choices shown, sharing whole packs when
// several lines use the same product at the same store and sales channel.
export function purchaseTotalCents(choices: PriceChoice[], advanced: boolean): number {
  if (!advanced) return choices.reduce((sum, choice) => sum + choice.cents, 0);
  const groups = new Map<string, { demand: bigint; capacity: bigint; unitCents: number }>();
  for (const [index, choice] of choices.entries()) {
    const quantity = choice.demand ?? purchaseDemand(choice.item, choice.product, true);
    const unitCents = validPrice(choice.reading);
    if (!quantity || unitCents === null) return NaN;
    const baseKey = storeKey(choice.reading) + ":" + choice.product.id;
    const current = groups.get(baseKey);
    // Never combine contradictory package snapshots or price readings.
    const key = current && (current.capacity !== quantity.capacity || current.unitCents !== unitCents)
      ? baseKey + ":" + index : baseKey;
    const group = groups.get(key);
    if (group) group.demand += quantity.demand;
    else groups.set(key, { ...quantity, unitCents });
  }
  return [...groups.values()].reduce((sum, group) =>
    sum + Number((group.demand + group.capacity - 1n) / group.capacity) * group.unitCents, 0);
}

const BASE_UNITS: BaseUnit[] = ["g", "ml", "piece"];
const EPSILON = 1e-9;

/**
 * How a line is compared per unit: the unit of measure (what the requested quantity is in, else the chosen one
 * when its candidates have it, else the one most of them are measured in) and the amount needed (the requested
 * amount, or one smallest pack per package asked). A product can be measured in several units (a multipack is a
 * weight and a count), so the unit can be switched. Null when no candidate has a known size in the unit, for
 * instance a requested quantity in grams for candidates measured in pieces: the line is then compared on the
 * pack price.
 */
function unitLine(line: BasketLine, advanced: boolean, chosen?: BaseUnit): UnitLine | null {
  const sizes = [...new Map(line.candidates.map(product => [product.id, product])).values()].map(productSizes);
  const covers = (unit: BaseUnit) => sizes.filter(list => list.some(size => size.unit === unit)).length;
  const available = BASE_UNITS.filter(unit => covers(unit) > 0);
  if (!available.length) return null;
  const requested = advanced && line.item.quantity ? baseQuantity(line.item.quantity) : null;
  if (requested && !available.includes(requested.unit)) return null;
  const unit = requested?.unit
    ?? (chosen && available.includes(chosen) ? chosen : available.reduce((best, candidate) => covers(candidate) > covers(best) ? candidate : best));
  const smallest = Math.min(...sizes.flatMap(list => list.filter(size => size.unit === unit).map(size => size.amount)));
  const packs = advanced && line.item.quantity?.unit === "package" ? Number(line.item.quantity.amount) : 1;
  const need = requested ? requested.amount : packs * smallest;
  return need > 0 && Number.isFinite(need) ? { unit, need, available, fixed: requested !== null } : null;
}
type UnitLine = { unit: BaseUnit; need: number; available: BaseUnit[]; fixed: boolean };

function unitQuantity(packageCents: number, size: { amount: number; unit: BaseUnit }, line: UnitLine) {
  const { need } = line;
  const packages = Math.max(1, Math.ceil(Math.round(need * 1000000) / Math.round(size.amount * 1000000)));
  if (!Number.isSafeInteger(packages) || packages > 999999) return null;
  const surplus = Math.max(0, Math.round((packages * size.amount - need) * 1000000) / 1000000);
  return {
    packages, cents: packageCents * packages, usedCents: packageCents * need / size.amount, used: surplus > EPSILON,
    unit: { perUnitCents: packageCents / size.amount, unit: size.unit, surplus, available: line.available, fixed: line.fixed },
    demand: { demand: microUnits(need), capacity: microUnits(size.amount) },
  };
}

function cheaperPerUnit(left: PriceChoice, right: PriceChoice) {
  const gap = (left.unit?.perUnitCents ?? 0) - (right.unit?.perUnitCents ?? 0);
  return (Math.abs(gap) > EPSILON ? gap : 0) || cheaper(left, right);
}

export function buildBasketComparison(
  lines: BasketLine[], responses: Map<number, BasketPriceResponse | null>,
  filters: BasketFilters = emptyBasketFilters,
  advanced = false,
  excluded: ReadonlySet<string> = new Set(),
  mode: CompareMode = "price",
  unitChoices: UnitChoices = noChoice,
): BasketComparison {
  const stores = new Map<string, StoreQuote>();
  const split: PriceChoice[] = [], missing: BasketItem[] = [], failed: BasketItem[] = [], truncated: BasketItem[] = [];
  const withdrawnSeen = new Set<number>();
  let withdrawn = 0;
  for (const line of lines) {
    const products = [...new Map(line.candidates.map(product => [product.id, product])).values()];
    if (!products.length || products.some(product => !responses.get(product.id))) {
      failed.push(line.item); missing.push(line.item); continue;
    }
    if (products.some(product => responses.get(product.id)?.stores_truncated)) truncated.push(line.item);
    for (const product of products) if (!withdrawnSeen.has(product.id)) {
      withdrawnSeen.add(product.id); withdrawn += responses.get(product.id)?.withdrawn_count ?? 0;
    }
    const byStore = new Map<string, PriceChoice>();
    const perUnit = mode === "unit" ? unitLine(line, advanced, unitChoices(line.item)) : null;
    const compare = perUnit ? cheaperPerUnit : cheaper;
    for (const product of products) for (const reading of responses.get(product.id)!.latest_by_store) {
      const cents = validPrice(reading);
      if (cents === null || !matchesBasketFilters(reading, filters) || excluded.has(storeKey(reading))) continue;
      let quantity;
      if (perUnit) {
        const size = productSizeIn(product, perUnit.unit);
        quantity = size ? unitQuantity(cents, size, perUnit) : null;
      } else quantity = pricedQuantity(line.item, product, cents, advanced);
      if (!quantity) continue;
      const choice: PriceChoice = { item: line.item, product, reading, ...quantity };
      const key = storeKey(reading), current = byStore.get(key);
      if (!current || compare(choice, current) < 0) byStore.set(key, choice);
    }
    const choices = [...byStore.values()].sort(compare);
    if (choices.length) split.push(choices[0]);
    else missing.push(line.item);
    for (const [key, choice] of byStore) {
      let store = stores.get(key);
      if (!store) {
        store = { key, reading: choice.reading, choices: [], cents: 0, usedCents: 0, coverage: 0 };
        stores.set(key, store);
      }
      store.choices.push(choice); store.coverage += 1;
    }
  }
  for (const store of stores.values()) {
    store.cents = purchaseTotalCents(store.choices, advanced);
    store.usedCents = store.choices.reduce((sum, choice) => sum + choice.usedCents, 0);
  }
  const storeList = [...stores.values()].sort((left, right) => {
    const leftComplete = left.coverage === lines.length, rightComplete = right.coverage === lines.length;
    if (leftComplete !== rightComplete) return leftComplete ? -1 : 1;
    if (!leftComplete && left.coverage !== right.coverage) return right.coverage - left.coverage;
    // Per unit, what the needed amounts are worth decides; the cash to pay only breaks ties.
    const first = mode === "unit" ? Math.round(left.usedCents) - Math.round(right.usedCents) : 0;
    return first || left.cents - right.cents || left.reading.store_name.localeCompare(right.reading.store_name, "fr");
  });
  return { stores: storeList, split, splitCents: purchaseTotalCents(split, advanced),
    splitUsedCents: split.reduce((sum, choice) => sum + choice.usedCents, 0), missing, failed, truncated, withdrawn };
}

/** What a store of the split brings: the extra spending without it, and the articles only it prices. */
export type StoreSaving = { extraCents: number; unpriced: number };

/**
 * For each store of the split, the split is built again without that store (same filters, same quantities),
 * so each article takes its next lowest price elsewhere. `extraCents` compares the two totals on the articles
 * that still have a price; `unpriced` counts those that have none without the store, which are left out of the
 * comparison because no other price exists for them.
 */
export function splitSavings(
  lines: BasketLine[], responses: Map<number, BasketPriceResponse | null>,
  filters: BasketFilters, advanced: boolean, baseline: BasketComparison, mode: CompareMode = "price",
  unitChoices: UnitChoices = noChoice, excluded: ReadonlySet<string> = new Set(),
): Map<string, StoreSaving> {
  const result = new Map<string, StoreSaving>();
  for (const key of new Set(baseline.split.map(choice => storeKey(choice.reading)))) {
    const without = buildBasketComparison(lines, responses, filters, advanced, new Set([...excluded, key]), mode, unitChoices);
    const stillPriced = new Set(without.split.map(choice => choice.item));
    const kept = baseline.split.filter(choice => stillPriced.has(choice.item));
    // Per unit the saving is on the value of the amounts needed, since the packs bought differ between the two splits.
    const extraCents = mode === "unit"
      ? Math.max(0, Math.round(without.splitUsedCents - kept.reduce((sum, choice) => sum + choice.usedCents, 0)))
      : without.splitCents - purchaseTotalCents(kept, advanced);
    if (!Number.isFinite(extraCents)) continue;
    result.set(key, { extraCents, unpriced: baseline.split.length - kept.length });
  }
  return result;
}

/**
 * For each store left out of the split (`excluded`), what putting it back would bring: the split is built
 * again with it, `extraCents` is how much less the articles already priced would cost (their needed amounts,
 * per unit), and `unpriced` counts the articles that only this store would price. `current` is the split
 * without the excluded stores.
 */
export function reactivationGains(
  lines: BasketLine[], responses: Map<number, BasketPriceResponse | null>,
  filters: BasketFilters, advanced: boolean, current: BasketComparison, excluded: ReadonlySet<string>,
  mode: CompareMode = "price", unitChoices: UnitChoices = noChoice,
): Map<string, StoreSaving> {
  const result = new Map<string, StoreSaving>();
  const priced = new Set(current.split.map(choice => choice.item));
  for (const key of excluded) {
    const rest = new Set(excluded);
    rest.delete(key);
    const back = buildBasketComparison(lines, responses, filters, advanced, rest, mode, unitChoices);
    const kept = back.split.filter(choice => priced.has(choice.item));
    const extraCents = mode === "unit"
      ? Math.max(0, Math.round(current.splitUsedCents - kept.reduce((sum, choice) => sum + choice.usedCents, 0)))
      : Math.max(0, current.splitCents - purchaseTotalCents(kept, advanced));
    if (!Number.isFinite(extraCents)) continue;
    result.set(key, { extraCents, unpriced: back.split.length - kept.length });
  }
  return result;
}

