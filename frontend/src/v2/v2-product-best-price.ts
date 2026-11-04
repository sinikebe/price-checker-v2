/** The lowest current price of a product, from its latest reading per store (pure, so it can be unit-tested). */
export type LatestReading = {
  price: string; observed_at: string; retailer: string; store_name: string;
  city: string | null; online?: boolean; available?: boolean; correction_status?: string | null;
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
