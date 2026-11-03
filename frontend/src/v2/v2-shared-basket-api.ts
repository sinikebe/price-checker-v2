import type { InvitePreview, SharedBasket, SharedPrices, SharedSettings, SharedSummary, SharedView, WireOp } from "./v2-shared-basket";
import { NoCreditsError, SignedOutError, type BasketCredits } from "./v2-basket-credits-api";

const BASE = "/api/v2/shared-baskets";

/** A refusal from the server, with its status (404: the basket is gone or the access was removed). */
export class SharedBasketError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

async function request<T>(path: string, method = "GET", body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(BASE + path, {
    method, credentials: "same-origin", cache: "no-store", signal,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : null;
    throw new SharedBasketError(typeof detail === "string" ? detail
      : response.status === 401 ? "Connectez-vous pour utiliser un panier partagé." : "Le panier partagé ne répond pas. Réessayez.", response.status);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export const listSharedBaskets = () => request<{ baskets: SharedSummary[]; limits: { owned: number; joined: number } }>("");
export const createSharedBasket = (name: string, lines: WireOp[], settings?: Partial<SharedSettings>) =>
  request<SharedBasket>("", "POST", { name, settings, lines: lines.flatMap(op => op.op === "add" ? [{ line: op.line, quantity: op.quantity, disabled: op.disabled }] : []) });
export const readSharedBasket = (id: number, signal?: AbortSignal) => request<SharedBasket>(`/${id}`, "GET", undefined, signal);
export const changeSharedBasket = (id: number, ops: WireOp[]) => request<SharedBasket>(`/${id}/changes`, "POST", { ops });
export const renameSharedBasket = (id: number, name: string) => request<SharedBasket>(`/${id}`, "PATCH", { name });
export const renewSharedInvite = (id: number) => request<SharedBasket>(`/${id}/invite`, "POST");
export const removeSharedMember = (id: number, userId: number) => request<void>(`/${id}/members/${userId}`, "DELETE");
export const deleteSharedBasket = (id: number) => request<void>(`/${id}`, "DELETE");
export const previewInvite = (invite: string) => request<InvitePreview>("/join", "POST", { invite });
export const joinSharedBasket = (invite: string) => request<InvitePreview>("/join", "POST", { invite, confirm: true });

/**
 * Wait for the next version of the basket: the server answers as soon as a member changes it, or
 * after about 25 s with nothing (null). `retryAfter` asks to wait before reading again.
 */
export async function waitSharedBasket(id: number, revision: number, signal: AbortSignal): Promise<{ basket: SharedBasket | null; retryAfter: number }> {
  const response = await fetch(`${BASE}/${id}?after=${revision}&wait=true`, { credentials: "same-origin", cache: "no-store", signal });
  if (response.status === 204) return { basket: null, retryAfter: Number(response.headers.get("Retry-After")) || 0 };
  if (!response.ok) throw new SharedBasketError("Le panier partagé ne répond pas.", response.status);
  return { basket: await response.json() as SharedBasket, retryAfter: 0 };
}

/** The prices a member fetched for the basket (null: never fetched). */
export const readSharedBasketPrices = (id: number, signal?: AbortSignal) => request<{ prices: SharedPrices | null }>(`/${id}/prices`, "GET", undefined, signal);

/** Fetch the basket's prices with this account's credits (one per included article): every member then sees them. */
export async function fetchSharedBasketPrices(id: number, cost: number): Promise<{ prices: SharedPrices; credits: BasketCredits; cost: number }> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/${id}/prices`, { method: "POST", credentials: "same-origin", cache: "no-store" });
  } catch { throw new Error("Connexion interrompue. Vérifiez votre solde de crédits avant de réessayer."); }
  if (response.status === 401) throw new SignedOutError();
  if (response.status === 429) {
    const body = await response.json().catch(() => null) as { detail?: { code?: string; credits?: BasketCredits; cost?: number; message?: string } } | null;
    if (body?.detail?.code === "no_credits" && body.detail.credits) throw new NoCreditsError(body.detail.credits, body.detail.cost ?? cost, body.detail.message);
    throw new Error("Trop de requêtes. Réessayez dans un instant.");
  }
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : null;
    throw new SharedBasketError(typeof detail === "string" ? detail : "Impossible de récupérer les prix. Aucun crédit n’a été dépensé.", response.status);
  }
  return response.json() as Promise<{ prices: SharedPrices; credits: BasketCredits; cost: number }>;
}

/** A shared basket through its link, without an account: read only. */
export const viewSharedBasket = (invite: string, signal?: AbortSignal) => request<SharedView>("/view", "POST", { invite }, signal);
