export type StoreCandidate = {
  id: number; retailer: string; name: string; city: string | null;
  postal_code: string | null; match: "exact" | "near"; matched_name: string;
};
export type StoreMatches = { matches: StoreCandidate[]; exact_store_id: number | null };
export type AliasSource = "retailer" | "open_food_facts" | "open_prices";
export type AliasProposal = {
  id: number; store_id: number; name: string; source: AliasSource;
  store_name: string; retailer: string; city: string | null; postal_code: string | null;
  author: string; created_at: string;
};

export async function storeRequest<T>(path: string, method = "GET", body?: object): Promise<T> {
  const response = await fetch("/api/v2/stores" + path, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: string } | null;
    throw new Error(payload?.detail || "Recherche ou proposition de magasin impossible.");
  }
  return response.json() as Promise<T>;
}

export function storeMatchesPath(input: {
  retailer: string; store_name: string; city: string; postal_code: string;
}, source: AliasSource = "retailer") {
  const query = new URLSearchParams({ retailer: input.retailer, name: input.store_name,
    city: input.city, postal_code: input.postal_code, source });
  return "/matches?" + query.toString();
}
