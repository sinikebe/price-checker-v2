import type { BasketItem, BasketProduct } from "./v2-basket-storage";
import type { BasketPriceResponse } from "./v2-basket-comparison";

export type BasketCredits = {
  balance: number; daily_grant: number; weekly_max: number; hold_max: number;
  granted_this_week: number; next_grant_on: string;
};
export type BasketFetchResult = {
  fetched_at: string; credits: BasketCredits;
  lines: { product_ids: number[]; truncated: boolean }[];
  products: Record<string, BasketProduct>;
  prices: Record<string, BasketPriceResponse>;
};
/** The account has no credit left: nothing was spent, and `credits` says when the next one comes. */
export class NoCreditsError extends Error {
  credits: BasketCredits;
  constructor(credits: BasketCredits) { super("Plus de crédit pour récupérer les prix du panier."); this.credits = credits; }
}
/** The session is gone: signing in again is needed. */
export class SignedOutError extends Error {}

type WireItem =
  | { kind: "product"; id: number }
  | { kind: "group"; name: string }
  | { kind: "scope"; department: string; family: string; name: string };
export function wireItems(items: readonly BasketItem[]): WireItem[] {
  return items.map((item): WireItem => !("kind" in item) ? { kind: "product", id: item.id }
    : item.kind === "group" ? { kind: "group", name: item.name }
      : { kind: "scope", department: item.department, family: item.family, name: item.name });
}

export async function readBasketCredits(signal?: AbortSignal): Promise<BasketCredits> {
  const response = await fetch("/api/v2/basket/credits", { credentials: "same-origin", cache: "no-store", signal });
  if (response.status === 401) throw new SignedOutError();
  if (!response.ok) throw new Error("Crédits indisponibles");
  return response.json() as Promise<BasketCredits>;
}

/** One request and one credit for the candidates and latest prices of every line. */
export async function fetchBasketPrices(items: readonly BasketItem[]): Promise<BasketFetchResult> {
  let response: Response;
  try {
    response = await fetch("/api/v2/basket/prices", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: wireItems(items) }),
    });
  } catch { throw new Error("Connexion interrompue. Vérifiez votre solde de crédits avant de réessayer."); }
  if (response.status === 401) throw new SignedOutError();
  if (response.status === 429) {
    const body = await response.json().catch(() => null) as { detail?: { code?: string; credits?: BasketCredits } } | null;
    if (body?.detail?.code === "no_credits" && body.detail.credits) throw new NoCreditsError(body.detail.credits);
    throw new Error("Trop de requêtes. Réessayez dans un instant.");
  }
  if (!response.ok) throw new Error("Impossible de récupérer les prix. Aucun crédit n’a été dépensé.");
  return response.json() as Promise<BasketFetchResult>;
}

const days = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
/** "demain", or the weekday of a later day, for the date of the next grant (YYYY-MM-DD). */
export function nextGrantLabel(nextGrantOn: string, today: Date = new Date()): string {
  const [year, month, day] = nextGrantOn.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const distance = Math.round((target - now) / 86400000);
  if (distance <= 1) return "demain";
  return days[new Date(target).getUTCDay()];
}
export const creditLabel = (count: number) => count + " crédit" + (count > 1 ? "s" : "");
