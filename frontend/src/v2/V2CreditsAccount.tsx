import { useEffect, useState } from "react";
import { creditLabel, nextGrantLabel, readCredits, rewardSummary, type BasketCredits } from "./v2-basket-credits-api";
import { creditRewards, rewardLine, type RewardList } from "./v2-credit-rewards";

/** The account's credits, in plain words: what is left, how they come back, and what contributions earn. */
export default function V2CreditsAccount() {
  const [credits, setCredits] = useState<BasketCredits | null>(null);
  const [rewards, setRewards] = useState<RewardList | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([readCredits(controller.signal), creditRewards(controller.signal)])
      .then(([state, list]) => { if (!controller.signal.aborted) { setCredits(state); setRewards(list); } })
      .catch(() => { if (!controller.signal.aborted) setError("Vos crédits n’ont pas pu être chargés."); });
    return () => controller.abort();
  }, []);
  const earn = credits?.rewards ? rewardSummary(credits.rewards) : "";
  return <section className="v2-settings-card v2-credits-account" aria-labelledby="v2-credits-account-heading">
    <h2 id="v2-credits-account-heading">Vos crédits</h2>
    {error ? <p className="v2-schedule-error" role="alert">{error}</p> : !credits ? <p>Chargement…</p> : credits.unlimited
      ? <p>Votre compte administrateur n’est pas limité : les prix s’affichent sans crédit.</p> : <>
        <dl className="v2-credits-figures">
          <div><dt>Crédits du jour</dt><dd>{credits.balance}</dd>
            <small>{credits.daily_grant} offerts chaque jour, {credits.hold_max} gardés au plus. Les prochains arrivent {nextGrantLabel(credits.next_grant_on)}.</small></div>
          <div><dt>Crédits de contribution</dt><dd>{credits.bonus ?? 0}</dd>
            <small>Sans limite et sans date d’expiration. Ils servent seulement quand les crédits du jour sont épuisés.</small></div>
        </dl>
        <p>Voir des prix coûte des crédits : 1 pour un produit, 1 par produit avec un prix pour un groupe ou un ensemble, 1 par article pour le panier.
          {earn ? ` Chaque contribution validée par un administrateur vous en rapporte : ${earn}.` : ""}</p>
        {rewards && rewards.rewards.length > 0 && <>
          <h3>Vos dernières contributions récompensées</h3>
          <ul className="v2-credits-rewards">{rewards.rewards.map((item, index) => <li key={index}>{rewardLine(item)}</li>)}</ul>
          <small>{creditLabel(rewards.earned_total)} gagnés en tout grâce à vos contributions.</small>
        </>}
      </>}
  </section>;
}
