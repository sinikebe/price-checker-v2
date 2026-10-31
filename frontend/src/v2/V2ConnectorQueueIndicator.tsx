import { useEffect, useState } from "react";
import "./v2-connector-queue.css";

export const CONNECTOR_PRICE_REFRESH_EVENT = "v2-connector-price-refreshed";
type ProductStatus = { status: string; rank: number | null; store_name?: string | null };
type InstalledConnector = { id: string; name: string; enabled: boolean };
export type QueueBadge = ProductStatus & { connector: string; connectorId: string; productId: number };

async function statuses(connector: InstalledConnector, ids: number[], refresh: boolean): Promise<Record<string, ProductStatus>> {
  const response = await fetch(`/api/v2/connector-stores/${encodeURIComponent(connector.id)}/products/${refresh ? "page-refresh" : "status"}`, {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product_ids: ids }),
  });
  if (!response.ok) throw new Error("Connector status unavailable");
  return (await response.json() as { products: Record<string, ProductStatus> }).products;
}

export function useConnectorQueue(productIds: number[]): QueueBadge[] {
  const key = [...new Set(productIds)].filter(id => Number.isSafeInteger(id) && id > 0).join(",");
  const [badges, setBadges] = useState<QueueBadge[]>([]);
  useEffect(() => {
    if (!key || !navigator.onLine) { setBadges([]); return; }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous = new Map<string, string>();
    const ids = key.split(",").map(Number);
    async function check(refresh: boolean) {
      const versions = await fetch("/api/v2/connector-stores/versions", { cache: "no-store" })
        .then(response => response.ok ? response.json() as Promise<{ connectors: InstalledConnector[] }> : { connectors: [] })
        .catch(() => ({ connectors: [] as InstalledConnector[] }));
      const connectors = versions.connectors.filter(item => item.enabled);
      if (!active) return;
      const results = await Promise.all(connectors.map(async connector => {
        const products: Record<string, ProductStatus> = {};
        for (let offset = 0; offset < ids.length; offset += 50) {
          try { Object.assign(products, await statuses(connector, ids.slice(offset, offset + 50), refresh)); }
          catch { break; }
        }
        return { connector, products };
      }));
      if (!active) return;
      const next = results.flatMap(({ connector, products }) => ids.flatMap(productId => {
        const item = products[String(productId)];
        return item ? [{ ...item, connector: connector.name, connectorId: connector.id, productId }] : [];
      }));
      const completed = next.some(item => {
        const old = previous.get(`${item.connectorId}:${item.productId}`);
        return (old === "queued" || old === "running") && item.status !== "queued" && item.status !== "running";
      });
      previous = new Map(next.map(item => [`${item.connectorId}:${item.productId}`, item.status]));
      setBadges(next.filter(item => item.status === "queued" || item.status === "running"));
      if (completed) window.dispatchEvent(new Event(CONNECTOR_PRICE_REFRESH_EVENT));
      if (next.some(item => item.status === "queued" || item.status === "running"))
        timer = setTimeout(() => { void check(false); }, 30_000);
    }
    void check(true);
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [key]);
  return badges;
}

export function V2ConnectorQueueIndicator({ badge }: { badge: QueueBadge }) {
  const label = badge.status === "running" ? "Relevé en cours"
    : `En attente${badge.rank ? ` · n° ${badge.rank}` : ""}`;
  return <span className="v2-connector-queue-badge" role="status"
    title={[badge.connector, badge.store_name, label].filter(Boolean).join(" · ")}>{label}</span>;
}
