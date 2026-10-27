import type { BasketProduct } from "./v2-basket-storage";

export type BasketPrice = {
  id: number;
  price: string;
  observed_at: string;
  retailer: string;
  store_name: string;
  store_id: number;
  city: string | null;
  postal_code: string | null;
  sales_channel: "in_store" | "drive" | "delivery";
  available: boolean;
  correction_status: string | null;
  source_provider: string | null;
};
export type BasketPriceResponse = {
  latest_by_store: BasketPrice[];
  stores_truncated: boolean;
};
export type PriceChoice = {
  product: BasketProduct;
  reading: BasketPrice;
  cents: number;
};
export type StoreQuote = {
  key: string;
  reading: BasketPrice;
  choices: PriceChoice[];
  cents: number;
  coverage: number;
};
export type BasketComparison = {
  stores: StoreQuote[];
  split: PriceChoice[];
  splitCents: number;
  missing: BasketProduct[];
  failed: BasketProduct[];
  truncated: BasketProduct[];
};

const storeKey = (row: BasketPrice) => String(row.store_id) + ":" + row.sales_channel;

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
    || left.reading.sales_channel.localeCompare(right.reading.sales_channel);
}

export function buildBasketComparison(
  products: BasketProduct[],
  responses: Map<number, BasketPriceResponse | null>,
): BasketComparison {
  const stores = new Map<string, StoreQuote>();
  const split: PriceChoice[] = [];
  const missing: BasketProduct[] = [];
  const failed: BasketProduct[] = [];
  const truncated: BasketProduct[] = [];

  for (const product of products) {
    const response = responses.get(product.id);
    if (!response) {
      failed.push(product);
      missing.push(product);
      continue;
    }
    if (response.stores_truncated) truncated.push(product);
    const choices: PriceChoice[] = [];
    for (const reading of response.latest_by_store) {
      const cents = validPrice(reading);
      if (cents === null) continue;
      const choice = { product, reading, cents };
      choices.push(choice);
      const key = storeKey(reading);
      let store = stores.get(key);
      if (!store) {
        store = { key, reading, choices: [], cents: 0, coverage: 0 };
        stores.set(key, store);
      }
      store.choices.push(choice);
      store.cents += cents;
      store.coverage += 1;
    }
    choices.sort(cheaper);
    if (choices.length) split.push(choices[0]);
    else missing.push(product);
  }

  const storeList = [...stores.values()].sort((left, right) => {
    const leftComplete = left.coverage === products.length;
    const rightComplete = right.coverage === products.length;
    if (leftComplete !== rightComplete) return leftComplete ? -1 : 1;
    if (!leftComplete && left.coverage !== right.coverage) return right.coverage - left.coverage;
    return left.cents - right.cents || left.reading.store_name.localeCompare(right.reading.store_name, "fr");
  });
  return {
    stores: storeList,
    split,
    splitCents: split.reduce((sum, choice) => sum + choice.cents, 0),
    missing,
    failed,
    truncated,
  };
}
