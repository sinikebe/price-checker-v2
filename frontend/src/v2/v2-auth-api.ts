export type V2User = {
  id: number;
  username: string;
  role: "admin" | "confirmed" | "visitor";
};
export type V2AuthStatus = {
  admin_initialized: boolean;
  user: V2User | null;
};

export async function authRequest<T>(path: string, method = "GET", body?: object): Promise<T> {
  const response = await fetch("/api/v2/auth/" + path, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const detail = data && typeof data === "object" && "detail" in data
      ? (data as { detail: unknown }).detail : null;
    throw new Error(typeof detail === "string" ? detail : "L'opération a échoué.");
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
