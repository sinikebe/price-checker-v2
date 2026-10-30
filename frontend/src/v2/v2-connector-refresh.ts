type InstalledConnector = { id: string; enabled: boolean };
let installed: Promise<InstalledConnector[]> | null = null;
let fetchedAt = 0;
const recentBasketRequests = new Map<number, number>();

async function connectors(): Promise<InstalledConnector[]> {
  if (!installed || Date.now() - fetchedAt > 30_000) {
    fetchedAt = Date.now();
    installed = fetch("/api/v2/connector-stores/versions", { cache: "no-store" })
    .then(response => response.ok ? response.json() : { connectors: [] })
    .then((result: { connectors: InstalledConnector[] }) => result.connectors.filter(item => item.enabled))
    .catch(() => { installed = null; return []; });
  }
  return installed;
}

export async function requestConnectorRefresh(productId: number): Promise<void> {
  if (!navigator.onLine || !Number.isSafeInteger(productId) || productId <= 0) return;
  for (const connector of await connectors()) {
    try {
      await fetch(`/api/v2/connector-stores/${encodeURIComponent(connector.id)}/products/${productId}/refresh`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
      });
    } catch { /* Optional connector must not interrupt shopping. */ }
  }
}

export async function requestBasketConnectorRefresh(productIds: number[]): Promise<void> {
  if (!navigator.onLine) return;
  const now = Date.now();
  const ids = [...new Set(productIds)].filter(id => Number.isSafeInteger(id) && id > 0
    && now - (recentBasketRequests.get(id) ?? 0) > 60_000);
  if (!ids.length) return;
  const active = await connectors();
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
