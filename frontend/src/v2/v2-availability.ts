/** Products a retailer no longer sells at one store: what the server says, and how the app words it. */
export type Channel = "in_store" | "drive" | "delivery";
export type WithdrawnStore = {
  store_id: number; store_name: string; city: string | null; retailer: string; sales_channel: Channel;
  since: string; checked: string; next_check: string | null;
};
export type Withdrawn = { stores: WithdrawnStore[]; truncated: boolean };
export type RecheckSettings = { recheck_days: number; revision: number; min: number; max: number };

const NONE: Withdrawn = { stores: [], truncated: false };

async function call<T>(url: string, method = "GET", body?: object): Promise<T> {
  const response = await fetch(url, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : null;
    throw new Error(typeof detail === "string" ? detail : "L’opération n’a pas abouti.");
  }
  return response.json() as Promise<T>;
}

/** The stores where a product is withdrawn. A failure is not worth a message: the prices still show. */
export async function loadWithdrawn(productId: number): Promise<Withdrawn> {
  try { return await call<Withdrawn>(`/api/v2/availability/products/${productId}`); }
  catch { return NONE; }
}

/** Administrators: forget the status, so the connector reads the page again at its next turn. */
export function lookAgain(productId: number, storeId: number, channel: Channel): Promise<Withdrawn> {
  return call<Withdrawn>(`/api/v2/availability/products/${productId}/stores/${storeId}?channel=${channel}`, "DELETE");
}

export const loadRecheckSettings = () => call<RecheckSettings>("/api/v2/availability/settings");
export const saveRecheckSettings = (recheckDays: number, expectedRevision: number) =>
  call<RecheckSettings>("/api/v2/availability/settings", "PUT", { recheck_days: recheckDays, expected_revision: expectedRevision });

export function withdrawnAt(list: readonly WithdrawnStore[], storeId: number, channel: string): WithdrawnStore | undefined {
  return list.find(entry => entry.store_id === storeId && entry.sales_channel === channel);
}

/** "2026-11-01" shown as 01/11/2026, without going through a time zone. */
export function dayLabel(day: string): string {
  const parts = day.split("-");
  return parts.length === 3 ? parts.reverse().join("/") : day;
}

export function withdrawnText(entry: WithdrawnStore): string {
  const since = `Retiré de la gamme depuis le ${dayLabel(entry.since)}`;
  return entry.next_check ? `${since} · nouvelle vérification à partir du ${dayLabel(entry.next_check)}`
    : `${since} · pas de nouvelle vérification automatique`;
}

export function recheckSummary(days: number): string {
  if (days === 0) return "Un produit retiré de la gamme d’un magasin n’est jamais relu automatiquement.";
  return `Un produit retiré de la gamme d’un magasin est relu après ${days} jour${days > 1 ? "s" : ""}, pas à chaque cycle de fraîcheur.`;
}

export function withdrawnPricesText(count: number): string {
  return `${count} prix ignoré${count > 1 ? "s" : ""} : produit retiré de la gamme du magasin concerné, sans relevé plus récent.`;
}
