import type { SearchScope } from "./v2-catalogue-search";

export type SuggestResult<T> = { total: number; complete: boolean; max: number; items: T[] };

/** The server refused a search for now: how many seconds to wait. */
export class RateLimitedError extends Error {
  readonly retryAfter: number;
  constructor(retryAfter: number) { super("Trop de recherches."); this.retryAfter = retryAfter; }
}

/** The number of seconds of a Retry-After header, kept within a minute to an hour. */
export function retryAfterSeconds(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 1 ? Math.min(3600, Math.ceil(seconds)) : 60;
}

export async function suggestRequest<T>(query: string, scope: SearchScope, signal: AbortSignal): Promise<SuggestResult<T>> {
  const params = new URLSearchParams({ q: query });
  if (scope.category) params.set("category", scope.category);
  if (scope.storeId) params.set("store_id", String(scope.storeId));
  const response = await fetch("/api/v2/catalogue/suggest?" + params.toString(), { credentials: "same-origin", signal });
  if (response.status === 429) throw new RateLimitedError(retryAfterSeconds(response.headers.get("Retry-After")));
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : null;
    throw new Error(typeof detail === "string" ? detail : `La recherche est indisponible (${response.status}).`);
  }
  return response.json() as Promise<SuggestResult<T>>;
}
