import { useEffect, useState } from "react";
import { isActiveStatus, readingFinished } from "./v2-connector-queue-state";
import { enabledConnectors, type InstalledConnector } from "./v2-connector-refresh";

export const CONNECTOR_PRICE_REFRESH_EVENT = "v2-connector-price-refreshed";
type ProductStatus = { status: string; rank: number | null; store_name?: string | null };
export type QueueBadge = ProductStatus & { connector: string; connectorId: string; productId: number };

async function statuses(connector: InstalledConnector, ids: number[], refresh: boolean): Promise<Record<string, ProductStatus>> {
  const response = await fetch(`/api/v2/connector-stores/${encodeURIComponent(connector.id)}/products/${refresh ? "page-refresh" : "status"}`, {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product_ids: ids }),
  });
  if (!response.ok) throw new Error("Connector status unavailable");
  return (await response.json() as { products: Record<string, ProductStatus> }).products;
}

/**
 * A price page asks the enabled connectors to refresh its products (each connector decides, within
 * its budgets). Only administrators see the reading status and follow it until the price arrives.
 */
export function useConnectorQueue(productIds: number[], admin = false): QueueBadge[] {
  const key = [...new Set(productIds)].filter(id => Number.isSafeInteger(id) && id > 0).join(",");
  const [state, setState] = useState<{ key: string; badges: QueueBadge[] }>({ key: "", badges: [] });
  useEffect(() => {
    if (!key || !navigator.onLine) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous = new Map<string, string>();
    const ids = key.split(",").map(Number);
    async function check(refresh: boolean) {
      const connectors = await enabledConnectors();
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
      const completed = next.some(item =>
        readingFinished(previous.get(`${item.connectorId}:${item.productId}`), item.status));
      previous = new Map(next.map(item => [`${item.connectorId}:${item.productId}`, item.status]));
      if (!admin) return;
      setState({ key, badges: next.filter(item => isActiveStatus(item.status)) });
      if (completed) window.dispatchEvent(new Event(CONNECTOR_PRICE_REFRESH_EVENT));
      if (next.some(item => isActiveStatus(item.status)))
        timer = setTimeout(() => { void check(false); }, 30_000);
    }
    void check(true);
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [key, admin]);
  return state.key === key ? state.badges : [];
}

