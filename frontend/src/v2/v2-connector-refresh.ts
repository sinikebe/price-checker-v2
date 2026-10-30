type InstalledConnector = { id: string; enabled: boolean };
let installed: Promise<InstalledConnector[]> | null = null;
let fetchedAt = 0;

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
