import type { SavedList } from "./v2-saved-lists";

/** The server answered with a refusal (its status); a network failure is a TypeError instead. */
export class ListError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

async function request<T>(path: string, method = "GET", body?: object): Promise<T> {
  const response = await fetch("/api/v2/lists" + path, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : null;
    throw new ListError(typeof detail === "string" ? detail : "La liste n’a pas pu être enregistrée.", response.status);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export const fetchLists = () => request<{ lists: SavedList[]; limits: { lists: number; lines: number } }>("");
export const putList = (list: SavedList) => request<SavedList>(`/${list.id}`, "PUT", { name: list.name, content: list.content, checked: list.checked });
export const patchList = (id: string, change: { name?: string; checked?: string[] }) => request<SavedList>(`/${id}`, "PATCH", change);
export const deleteList = (id: string) => request<void>(`/${id}`, "DELETE");
