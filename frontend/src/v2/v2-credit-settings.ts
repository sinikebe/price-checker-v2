/** Administrator settings of the credits that pay for prices (pure helpers and the two requests). */
export type CreditAmounts = { daily_grant: number; hold_max: number; visitor_daily: number;
  reward_price: number; reward_product: number; reward_recipe: number };
export type CreditSettings = CreditAmounts & { revision: number; bounds: Record<keyof CreditAmounts, { min: number; max: number }> };
export const CREDIT_FIELDS: { key: keyof CreditAmounts; label: string; help: string }[] = [
  { key: "daily_grant", label: "Crédits donnés chaque jour à un compte", help: "Donnés à la première visite du jour (heure de Paris)." },
  { key: "hold_max", label: "Crédits gardés au maximum", help: "Au-delà, les crédits du jour sont perdus." },
  { key: "visitor_daily", label: "Crédits par jour pour un visiteur sans compte", help: "Comptés par adresse réseau, sans report ; 0 pour exiger un compte." },
  { key: "reward_price", label: "Crédits de contribution par relevé de prix validé", help: "Sans limite ni expiration, utilisés après les crédits du jour ; 0 pour ne rien donner." },
  { key: "reward_product", label: "Crédits de contribution par fiche produit validée", help: "Création ou modification d’une fiche." },
  { key: "reward_recipe", label: "Crédits de contribution par recette validée", help: "Nouvelle recette ou modification." },
];

/** The amounts typed, or the first field that is not a whole number within its bounds. */
export function readAmounts(draft: Record<keyof CreditAmounts, string>, settings: CreditSettings): CreditAmounts | { invalid: keyof CreditAmounts } {
  const out = {} as CreditAmounts;
  for (const { key } of CREDIT_FIELDS) {
    const text = draft[key].trim();
    const value = Number(text);
    const { min, max } = settings.bounds[key];
    if (!/^\d+$/.test(text) || value < min || value > max) return { invalid: key };
    out[key] = value;
  }
  return out;
}

/** "Un compte reçoit 50 crédits par jour et en garde 100 au plus ; un visiteur a 10 crédits par jour." */
export function creditSummary(amounts: CreditAmounts): string {
  const visitor = amounts.visitor_daily === 0 ? "il faut un compte pour voir les prix"
    : `un visiteur sans compte a ${amounts.visitor_daily} crédit${amounts.visitor_daily > 1 ? "s" : ""} par jour`;
  const rewards = [["relevé de prix", amounts.reward_price], ["fiche produit", amounts.reward_product], ["recette", amounts.reward_recipe]]
    .filter(([, value]) => Number(value) > 0).map(([what, value]) => `${value} par ${what}`).join(", ");
  return `Un compte reçoit ${amounts.daily_grant} crédit${amounts.daily_grant > 1 ? "s" : ""} par jour et en garde ${amounts.hold_max} au plus ; ${visitor}. Un prix de produit coûte 1 crédit, un groupe ou un ensemble 1 par produit avec un prix, un panier 1 par article.`
    + (rewards ? ` Contributions validées : ${rewards}.` : " Les contributions ne rapportent pas de crédits.");
}

async function request(method: "GET" | "PUT", body?: object): Promise<CreditSettings> {
  const response = await fetch("/api/v2/credits/settings", {
    method, credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 409) throw new Error("Réglages modifiés entre-temps : ils ont été rechargés.");
  if (!response.ok) throw new Error(method === "GET" ? "Les réglages n’ont pas pu être chargés." : "Les réglages n’ont pas pu être enregistrés.");
  return response.json() as Promise<CreditSettings>;
}
export const loadCreditSettings = () => request("GET");
export const saveCreditSettings = (amounts: CreditAmounts, revision: number) => request("PUT", { ...amounts, expected_revision: revision });
