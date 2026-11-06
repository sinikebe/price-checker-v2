import type { Channel } from "./v2-availability";
import { requestJson } from "./v2-http";

/**
 * A free request to the price API (proposals, captures, reviews): its answer, or an ApiError with the
 * server's message or `fallback`. The paid price pages go through paidFetch instead.
 */
export function priceRequest<T>(path: string, fallback: string, method = "GET", body?: object): Promise<T> {
  return requestJson<T>("/api/v2/prices" + path, { method, body, cache: "no-store", fallback });
}

/** The sales channels a reading may come from, in the order the price forms offer them. */
export const SALES_CHANNELS: Record<Channel, string> = { in_store: "En magasin", drive: "Drive", delivery: "Livraison" };

/** Today in the reader's time zone, as yyyy-mm-dd: the default (and latest) day of a reading. */
export function readingDay(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
