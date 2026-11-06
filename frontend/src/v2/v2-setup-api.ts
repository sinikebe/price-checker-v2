// The calls of the first-run and server setup forms (/api/v2/setup). Their errors keep these forms' wording:
// the server's detail, every validation message joined, or the English status line.

export type SetupStatus = { configured: boolean; app_env: string };
export type Provider = "postgres" | "supabase";
export type TlsMode = "disable" | "require" | "verify-full";
export type PublicDatabase = {
  provider: Provider;
  project_url: string;
  host: string;
  port: number;
  database: string;
  username: string;
  tls_mode: TlsMode;
  public_hostname?: string;
};

/** No answer at all: offline, or the server is unreachable. */
export class SetupNetworkError extends Error {}

/** Pull a human-readable message out of a FastAPI error body (`detail`). */
function extractDetail(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const detail = (data as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    // FastAPI validation errors: [{ loc, msg, type }, ...]
    return detail
      .map((d) =>
        d && typeof d === "object" && "msg" in d
          ? String((d as { msg: unknown }).msg)
          : String(d)
      )
      .join("; ");
  }
  return null;
}

/** A setup request and its JSON answer; every setup endpoint answers with JSON. */
export async function setupRequest<T>(path: string, method = "GET", body?: object): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/v2/setup/" + path, {
      method, credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new SetupNetworkError("Network Error"); }
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    throw new Error(extractDetail(data) || `Request failed with status code ${response.status}`);
  }
  return response.json() as Promise<T>;
}
