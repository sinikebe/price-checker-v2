/** The account's latest contribution credits (pure wording helpers and the request). */
export type Reward = { kind: "price" | "product" | "recipe"; credits: number; created_at: string };
export type RewardList = { rewards: Reward[]; earned_total: number };
const WHAT: Record<Reward["kind"], string> = { price: "relevé de prix validé", product: "fiche produit validée", recipe: "recette validée" };

/** "+5 crédits · relevé de prix validé · 2 nov." */
export function rewardLine(reward: Reward): string {
  const day = new Date(reward.created_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  return `+${reward.credits} crédit${reward.credits > 1 ? "s" : ""} · ${WHAT[reward.kind] ?? "contribution validée"} · ${day}`;
}

export async function creditRewards(signal?: AbortSignal): Promise<RewardList> {
  const response = await fetch("/api/v2/credits/rewards", { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new Error("Récompenses indisponibles");
  return response.json() as Promise<RewardList>;
}
