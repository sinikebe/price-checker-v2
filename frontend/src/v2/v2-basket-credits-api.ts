import type { BasketItem, BasketProduct, SelectionMember } from "./v2-basket-storage";
import type { BasketPriceResponse } from "./v2-basket-comparison";

/**
 * Credits pay for every price shown (product page, group or ensemble page, basket). An account
 * gets `daily_grant` a day and holds at most `hold_max`; a visitor without an account (`visitor`)
 * has `daily_grant` views a day, with nothing carried over.
 */
export type RewardAmounts = { price: number; product: number; recipe: number };
export type BasketCredits = {
  balance: number; daily_grant: number; hold_max: number; next_grant_on: string;
  /** Contribution credits: earned by validated contributions, no limit, no expiry, spent after the daily ones. */
  bonus?: number;
  /** What each kind of validated contribution earns. */
  rewards?: RewardAmounts;
  /** Administrators are not charged; `balance` is then only a placeholder. */
  unlimited?: boolean;
  visitor?: boolean;
};
/** Everything the reader can spend: the daily credits, then the contribution credits. */
export const spendable = (credits: BasketCredits) => credits.balance + (credits.bonus ?? 0);
export type BasketFetchResult = {
  fetched_at: string; credits: BasketCredits;
  lines: { product_ids: number[]; truncated: boolean }[];
  products: Record<string, BasketProduct>;
  prices: Record<string, BasketPriceResponse>;
};
/** Not enough credits for what was asked: nothing was spent, and `credits` says when the next ones come. */
export class NoCreditsError extends Error {
  credits: BasketCredits;
  cost: number;
  constructor(credits: BasketCredits, cost = 1, message = "Pas assez de crédits.") { super(message); this.credits = credits; this.cost = cost; }
}
/** The prices of the page now cost more than announced: nothing was spent; ask again with `cost`. */
export class CostChangedError extends Error {
  cost: number;
  constructor(cost: number) { super("Le nombre de prix a changé."); this.cost = cost; }
}
/** The session is gone: signing in again is needed. */
export class SignedOutError extends Error {}

type Refusal = { detail?: { code?: string; credits?: BasketCredits; cost?: number; message?: string } };
/**
 * Why a paid price request was refused with nothing spent: not enough credits (`fallbackCost` when the
 * server does not say the cost), a cost that changed meanwhile, or too many requests.
 */
export async function creditRefusal(response: Response, fallbackCost: number): Promise<Error> {
  const detail = (await response.json().catch(() => null) as Refusal | null)?.detail;
  if (detail?.code === "no_credits" && detail.credits) return new NoCreditsError(detail.credits, detail.cost ?? fallbackCost, detail.message);
  if (detail?.code === "cost_changed" && typeof detail.cost === "number") return new CostChangedError(detail.cost);
  return new Error("Trop de requêtes. Réessayez dans un instant.");
}
/**
 * A paid price request: a lost connection may have spent credits without an answer, so it says to check
 * the balance before trying again. A cancelled request stays an AbortError.
 */
export async function creditedFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw new Error("Connexion interrompue. Vérifiez votre solde de crédits avant de réessayer.");
  }
}

type WireItem =
  | { kind: "product"; id: number }
  | { kind: "group"; name: string }
  | { kind: "scope"; department: string; family: string; name: string }
  | { kind: "selection"; name: string; include: SelectionMember[]; exclude: SelectionMember[]; words: string[] };
/** What is priced for each article. Free text has no price: it is never sent (see fetchedItems). */
export function wireItems(items: readonly BasketItem[]): WireItem[] {
  return items.flatMap((item): WireItem[] => !("kind" in item) ? [{ kind: "product", id: item.id }]
    : item.kind === "group" ? [{ kind: "group", name: item.name }]
      : item.kind === "scope" ? [{ kind: "scope", department: item.department, family: item.family, name: item.name }]
        : item.kind === "selection" ? [{ kind: "selection", name: item.name, include: item.include, exclude: item.exclude ?? [], words: item.words ?? [] }] : []);
}

export async function readBasketCredits(signal?: AbortSignal): Promise<BasketCredits> {
  const response = await fetch("/api/v2/basket/credits", { credentials: "same-origin", cache: "no-store", signal });
  if (response.status === 401) throw new SignedOutError();
  if (!response.ok) throw new Error("Crédits indisponibles");
  return response.json() as Promise<BasketCredits>;
}

/** One request, and one credit per line, for the candidates and latest prices of every line. */
export async function fetchBasketPrices(items: readonly BasketItem[]): Promise<BasketFetchResult> {
  const response = await creditedFetch("/api/v2/basket/prices", {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: wireItems(items) }),
  });
  if (response.status === 401) throw new SignedOutError();
  if (response.status === 429) throw await creditRefusal(response, items.length);
  if (!response.ok) throw new Error("Impossible de récupérer les prix. Aucun crédit n’a été dépensé.");
  return response.json() as Promise<BasketFetchResult>;
}

/** The credits of whoever is reading: an account (after today's grant), a visitor, or an administrator. */
export async function readCredits(signal?: AbortSignal): Promise<BasketCredits> {
  const response = await fetch("/api/v2/credits", { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new Error("Crédits indisponibles");
  return response.json() as Promise<BasketCredits>;
}

/**
 * A paid price request (GET): its answer, or NoCreditsError / CostChangedError when nothing was spent.
 * The answer carries the credits left (`credits`).
 */
export async function paidFetch<T>(url: string, signal?: AbortSignal): Promise<T & { credits: BasketCredits }> {
  const response = await creditedFetch(url, { credentials: "same-origin", cache: "no-store", signal });
  if (response.status === 429 || response.status === 409) throw await creditRefusal(response, 1);
  if (response.status === 404) throw new Error("Introuvable.");
  if (!response.ok) throw new Error("Impossible de récupérer les prix. Aucun crédit n’a été dépensé.");
  return response.json() as Promise<T & { credits: BasketCredits }>;
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
/** True when the reader is known to have fewer than `cost` credits (never for an administrator). */
export const outOfCredits = (credits: BasketCredits | null, cost = 1) => credits !== null && !credits.unlimited && spendable(credits) < cost;
/** " (3 crédits)" after the action's name, and nothing for an administrator. */
export const costNote = (credits: BasketCredits | null, cost = 1) => credits?.unlimited ? "" : ` (${creditLabel(cost)})`;
/** "12 crédits restants", "12 crédits du jour et 30 crédits de contribution", or a visitor's credits of the day. */
export function balanceText(credits: BasketCredits): string {
  if (credits.unlimited) return "Sans limite pour un administrateur";
  if (credits.visitor) return `${creditLabel(credits.balance)} restant${credits.balance > 1 ? "s" : ""} aujourd’hui sans compte`;
  const bonus = credits.bonus ?? 0;
  if (bonus > 0) return `${creditLabel(credits.balance)} du jour et ${creditLabel(bonus)} de contribution`;
  return `${creditLabel(credits.balance)} restant${credits.balance > 1 ? "s" : ""}`;
}
const REWARD_WORDS: Record<keyof RewardAmounts, string> = { price: "relevé de prix", product: "fiche produit", recipe: "recette" };
/** "Une fois validé par un administrateur, ce relevé vous rapporte 5 crédits de contribution." Empty when it earns nothing. */
export function rewardHint(kind: keyof RewardAmounts, credits: BasketCredits | null): string {
  const amount = credits?.rewards?.[kind] ?? 0;
  if (!credits || credits.unlimited || credits.visitor || amount <= 0) return "";
  const what = kind === "price" ? "ce relevé" : kind === "product" ? "cette fiche" : "cette recette";
  return `Une fois ${kind === "price" ? "validé" : "validée"} par un administrateur, ${what} vous rapporte ${creditLabel(amount)} de contribution : ils n’expirent pas et servent quand vos crédits du jour sont épuisés.`;
}
/** "5 par relevé de prix, 10 par fiche produit, 10 par recette", without the kinds that earn nothing. */
export function rewardSummary(rewards: RewardAmounts): string {
  return (Object.keys(REWARD_WORDS) as (keyof RewardAmounts)[]).filter(kind => rewards[kind] > 0)
    .map(kind => `${rewards[kind]} par ${REWARD_WORDS[kind]}`).join(", ");
}
/** Why the reader cannot pay `cost`, and what comes next. */
export function shortText(credits: BasketCredits, cost: number): string {
  if (credits.visitor) {
    return credits.daily_grant === 0 ? "Connectez-vous pour voir les prix."
      : `Il faut ${creditLabel(cost)}, il en reste ${credits.balance} aujourd’hui sans compte. Connectez-vous pour avoir des crédits chaque jour, ou revenez ${nextGrantLabel(credits.next_grant_on)}.`;
  }
  const earn = credits.rewards && rewardSummary(credits.rewards);
  return `Il faut ${creditLabel(cost)}, il vous en reste ${spendable(credits)}. Les prochains arrivent ${nextGrantLabel(credits.next_grant_on)} (${credits.daily_grant} par jour, ${credits.hold_max} au maximum).`
    + (earn ? ` Vos contributions validées en rapportent aussi : ${earn}.` : "");
}
