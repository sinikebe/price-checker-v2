import { requestJson } from "./v2-http";

export type StoreCandidate = {
  id: number; retailer: string; retailer_id: number; retailer_group_id: number;
  name: string; city: string | null;
  postal_code: string | null; online?: boolean; match: "exact" | "near"; matched_name: string;
};
export type StoreMatches = { matches: StoreCandidate[]; exact_store_id: number | null };
export type AliasSource = "retailer" | "open_food_facts" | "open_prices";
export type AliasProposal = {
  id: number; store_id: number; name: string; source: AliasSource;
  store_name: string; retailer: string; city: string | null; postal_code: string | null;
  author: string; created_at: string;
};

export const storeRequest = <T>(path: string, method = "GET", body?: object): Promise<T> =>
  requestJson<T>("/api/v2/stores" + path, { method, body, cache: "no-store", fallback: "Recherche ou proposition de magasin impossible." });

export function storeMatchesPath(input: {
  retailer: string; store_name: string; city: string; postal_code: string;
}, source: AliasSource = "retailer") {
  const query = new URLSearchParams({ retailer: input.retailer, name: input.store_name,
    city: input.city, postal_code: input.postal_code, source });
  return "/matches?" + query.toString();
}
