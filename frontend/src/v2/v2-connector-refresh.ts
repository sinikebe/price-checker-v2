import type { BasketItem } from "./v2-basket-storage";

export type InstalledConnector = { id: string; name: string; enabled: boolean };
let installed: Promise<InstalledConnector[]> | null = null;
let fetchedAt = 0;
const recentBasketRequests = new Map<number, number>();

/**
 * The enabled connectors, asked at most every 30 seconds: the basket and the price pages share the
 * list. A request that does not reach the server is made again on the next call.
 */
export async function enabledConnectors(): Promise<InstalledConnector[]> {
  if (!installed || Date.now() - fetchedAt > 30_000) {
    fetchedAt = Date.now();
    installed = fetch("/api/v2/connector-stores/versions", { cache: "no-store" })
    .then(response => response.ok ? response.json() : { connectors: [] })
    .then((result: { connectors: InstalledConnector[] }) => result.connectors.filter(item => item.enabled))
    .catch(() => { installed = null; return []; });
  }
  return installed;
}

/** Drops the shared list after an administrator changed a connector: the next page asks again at once. */
export function forgetEnabledConnectors(): void {
  installed = null;
}

/** Products of `next` missing from `previous`: one basket change makes one batched request. */
export function addedProductIds(previous: ReadonlySet<number>, next: readonly BasketItem[]): number[] {
  return next.flatMap(item => "kind" in item ? [] : [item.id]).filter(id => !previous.has(id));
}

export async function requestBasketConnectorRefresh(productIds: number[]): Promise<void> {
  if (!navigator.onLine) return;
  const now = Date.now();
  const ids = [...new Set(productIds)].filter(id => Number.isSafeInteger(id) && id > 0
    && now - (recentBasketRequests.get(id) ?? 0) > 60_000);
  if (!ids.length) return;
  const active = await enabledConnectors();
  if (!active.length) return;
  for (const id of ids) recentBasketRequests.set(id, now);
  for (const connector of active) {
    for (let index = 0; index < ids.length; index += 50) {
      try {
        const response = await fetch(`/api/v2/connector-stores/${encodeURIComponent(connector.id)}/products/refresh`, {
          method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ product_ids: ids.slice(index, index + 50) }),
        });
        if (response.status === 429) break;
      } catch { break; /* Optional connector must not interrupt shopping. */ }
    }
  }
}
