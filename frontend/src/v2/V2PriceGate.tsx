import { balanceText, creditLabel, shortText, type BasketCredits } from "./v2-basket-credits-api";
import "./v2-price-gate.css";

const when = (value: string) => new Date(value).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * What seeing the prices of a page costs, said before anything is spent: the amount, the balance,
 * and one button. Prices already paid for are shown with their date and can be refreshed.
 */
export default function V2PriceGate({ cost, credits, fetchedAt, busy, error, newer, onPay, subject }: {
  cost: number; credits: BasketCredits | null; fetchedAt: string | null; busy: boolean; error: string; newer: boolean;
  onPay: () => void; subject: string;
}) {
  if (credits?.unlimited) return error ? <p className="v2-price-gate" role="alert">{error}</p> : null;
  if (cost === 0 && !fetchedAt) return <p className="v2-price-gate" role="status">Aucun prix relevé pour {subject} pour le moment.</p>;
  const short = credits !== null && credits.balance < cost;
  return <div className="v2-price-gate" role="group" aria-label="Prix payants en crédits">
    <p>{fetchedAt
      ? <>Prix récupérés le {when(fetchedAt)}{newer ? " · un nouveau relevé est arrivé" : ""}. Les actualiser coûte <strong>{creditLabel(cost)}</strong>.</>
      : <>Voir les prix de {subject} coûte <strong>{creditLabel(cost)}</strong>{cost > 1 ? " (1 par produit avec un prix)" : ""}.</>}
      {credits && <> {balanceText(credits)}.</>}</p>
    <button type="button" className={"v2-button " + (fetchedAt ? "v2-button-secondary" : "v2-button-primary")} disabled={busy || short || cost === 0}
      onClick={onPay}>{busy ? "Récupération…" : `${fetchedAt ? "Actualiser les prix" : "Voir les prix"} · ${creditLabel(cost)}`}</button>
    {short && credits && <p role="alert">{shortText(credits, cost)}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
