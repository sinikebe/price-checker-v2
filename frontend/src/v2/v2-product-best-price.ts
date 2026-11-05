/** The lowest current price of a product, from its latest reading per store (pure, so it can be unit-tested). */
export type LatestReading = {
  price: string; observed_at: string; retailer: string; store_name: string;
  store_id: number; city: string | null; postal_code: string | null;
  online?: boolean; available?: boolean; correction_status?: string | null;
};
export type BestPrice = { reading: LatestReading; cents: number; stores: number };

/** Leaves out readings marked unavailable or under correction; null when no usable reading is left. */
export function bestPrice(rows: readonly LatestReading[]): BestPrice | null {
  let best: { reading: LatestReading; cents: number } | null = null;
  let stores = 0;
  for (const reading of rows) {
    const value = Number(reading.price);
    if (reading.available === false || reading.correction_status === "active" || !Number.isFinite(value) || value < 0) continue;
    stores += 1;
    const cents = Math.round(value * 100);
    if (!best || cents < best.cents || (cents === best.cents && reading.observed_at > best.reading.observed_at)) best = { reading, cents };
  }
  return best ? { ...best, stores } : null;
}

/** Where the price was read: the store, then its town, or "en ligne" for an online platform. */
export function readingPlace(reading: LatestReading): string {
  return [reading.retailer, reading.store_name, reading.online ? "en ligne" : reading.city].filter(Boolean).join(" · ");
}

/** A reading of a group or ensemble page's price history (most recent last). */
export type HistoryReading = LatestReading & { id: number; product_id: number; sales_channel?: string };

/**
 * The lowest current price of each product of a page, from its recent readings: the latest reading of
 * each store and channel counts, older ones do not.
 */
export function bestPrices(readings: readonly HistoryReading[]): Map<number, BestPrice> {
  const latest = new Map<string, HistoryReading>();
  for (const reading of readings) {
    const key = `${reading.product_id}:${reading.store_id}:${reading.sales_channel ?? ""}`;
    const kept = latest.get(key);
    if (!kept || reading.observed_at > kept.observed_at || (reading.observed_at === kept.observed_at && reading.id > kept.id)) latest.set(key, reading);
  }
  const byProduct = new Map<number, HistoryReading[]>();
  for (const reading of latest.values()) byProduct.set(reading.product_id, [...(byProduct.get(reading.product_id) ?? []), reading]);
  const result = new Map<number, BestPrice>();
  for (const [productId, rows] of byProduct) {
    const best = bestPrice(rows);
    if (best) result.set(productId, best);
  }
  return result;
}
