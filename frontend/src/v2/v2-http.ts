// The one way the pages read a refusal of the V2 API and show a caught error. No imports: tests load
// this module on its own, and others inline it.

/** A refusal of the API, with its HTTP status for callers that react to one (409: changed meanwhile). */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/** The `detail` of a FastAPI error body, or null when the body is not JSON or has none. */
export async function errorDetail(response: Response): Promise<unknown> {
  const data: unknown = await response.json().catch(() => null);
  return data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : null;
}

/**
 * The message to show for a FastAPI `detail`: a plain text as it is, or the French message of a rule the
 * server checks itself (the first "value_error" of a validation list, without its technical prefix). The
 * built-in validation messages are English and technical, so they give the fallback.
 */
export function apiErrorText(detail: unknown, fallback: string): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    for (const item of detail as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const { type, msg } = item as { type?: unknown; msg?: unknown };
      if (type === "value_error" && typeof msg === "string") return msg.replace(/^Value error, /, "").slice(0, 300) || fallback;
    }
  }
  return fallback;
}

/** The error to throw for a refused response: its message, or the fallback, and its status. */
export async function apiError(response: Response, fallback: string): Promise<ApiError> {
  return new ApiError(apiErrorText(await errorDetail(response), fallback), response.status);
}

/**
 * A same-origin request with an optional JSON body, and its JSON answer (undefined for a 204). A refusal
 * throws an ApiError; a network failure keeps fetch's own TypeError, which callers read as "offline".
 */
export async function requestJson<T>(url: string, { method = "GET", body, cache, fallback }: {
  method?: string; body?: object; cache?: RequestCache; fallback: string;
}): Promise<T> {
  const response = await fetch(url, {
    method, credentials: "same-origin", ...(cache ? { cache } : {}),
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw await apiError(response, fallback);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/**
 * The text to show for a caught error: its own message, else the fallback. A TypeError is fetch's network
 * failure ("Failed to fetch") or a slip in the code, never a sentence written for the reader.
 */
export function errorText(reason: unknown, fallback: string): string {
  return reason instanceof Error && !(reason instanceof TypeError) && reason.message ? reason.message : fallback;
}
