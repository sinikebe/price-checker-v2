import { useContext, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CreditIcon, FilterIcon, ListIcon, QuantityIcon, RefreshIcon, ShareIcon, UnitPriceIcon } from "./V2SiteIcons";
import { creditLabel, nextGrantLabel, outOfCredits, spendable, type BasketCredits } from "./v2-basket-credits-api";
import { BasketReadOnlyContext, OFFLINE_TITLE } from "./v2-basket-read-only";

export type BasketPanel = "items" | "filters" | "share";

function Tool({ icon, label, detail, active, disabled, title, expanded, pressed, controls, onClick }: {
  icon: ReactNode; label: string; detail?: string; active: boolean; disabled?: boolean; title: string;
  expanded?: boolean; pressed?: boolean; controls?: string; onClick: () => void;
}) {
  return <button type="button" className="v2-basket-tool" data-active={active} disabled={disabled} title={title}
    aria-label={detail ? `${label} (${detail})` : label} aria-expanded={expanded} aria-pressed={pressed}
    aria-controls={expanded === undefined ? undefined : controls} onClick={onClick}>
    {icon}{active && <span className="v2-basket-tool-label">{label}</span>}
    {detail && <span className="v2-basket-tool-detail" aria-hidden="true">{detail}</span>}
  </button>;
}

/** The paid action that fetches the prices of a basket, with the credits left. */
export function V2BasketFetch({ signedIn, credits, cost, hasPrices, fetching, onFetch }: {
  signedIn: boolean; credits: BasketCredits | null; cost: number; hasPrices: boolean; fetching: boolean; onFetch: () => void;
}) {
  const empty = outOfCredits(credits, cost);
  const readOnly = useContext(BasketReadOnlyContext);
  const unlimited = credits?.unlimited === true;
  const creditTitle = unlimited ? "Crédits illimités pour les administrateurs."
    : credits
      ? `${creditLabel(credits.balance)} du jour (${credits.daily_grant} par jour, ${credits.hold_max} au maximum)`
        + ((credits.bonus ?? 0) > 0 ? ` et ${creditLabel(credits.bonus ?? 0)} de contribution, utilisés quand ceux du jour sont épuisés.` : ".")
      : "Chaque compte reçoit des crédits chaque jour.";
  return signedIn ? <div className="v2-basket-fetch">
      <span className="v2-basket-credits" title={creditTitle} data-empty={empty}><CreditIcon /><span>{unlimited ? <>∞<span className="v2-basket-credits-word"> crédits illimités</span></>
        : credits ? <>{spendable(credits)}<span className="v2-basket-credits-word"> crédit{spendable(credits) > 1 ? "s" : ""}</span></> : "Crédits"}</span></span>
      <button type="button" className="v2-button v2-button-primary" disabled={fetching || empty || readOnly} onClick={onFetch}
        title={readOnly ? OFFLINE_TITLE : empty && credits ? `Il faut ${creditLabel(cost)}, il en reste ${spendable(credits)}. Les prochains arrivent ${nextGrantLabel(credits.next_grant_on)}.`
          : unlimited ? "Récupérer les prix actuels : sans limite pour un administrateur" : `Récupérer les prix actuels : ${creditLabel(cost)} (1 par article inclus)`}>
        <RefreshIcon />{fetching ? "Récupération…" : hasPrices ? "Actualiser" : "Comparer les prix"}<small>{unlimited ? "illimité" : creditLabel(cost)}</small>
      </button>
    </div> : <Link className="v2-button v2-button-primary" to="/v2/connexion?next=panier">Se connecter pour comparer</Link>;
}

/** Icon buttons for the basket tools, and the action that brings the prices (`action`). */
export default function V2BasketToolbar({ panel, onPanel, itemCount, activeCount, advanced, onAdvanced, unitMode, onUnitMode, filterCount, filtersAvailable,
  shareable = true, action }: {
  panel: BasketPanel | null; onPanel: (panel: BasketPanel | null) => void; itemCount: number; activeCount: number;
  advanced: boolean; onAdvanced: (value: boolean) => void; unitMode: boolean; onUnitMode: (value: boolean) => void; filterCount: number; filtersAvailable: boolean;
  /** The demo basket has nothing to share. */
  shareable?: boolean; action: ReactNode;
}) {
  // Offline: the articles can still be read; settings, filters and sharing wait for the connection.
  const readOnly = useContext(BasketReadOnlyContext);
  return <div className="v2-basket-toolbar" role="group" aria-label="Outils du panier">
    <div className="v2-basket-tools">
      <Tool icon={<ListIcon />} label="Articles" detail={`${activeCount}/${itemCount}`} title="Articles du panier" active={panel === "items"}
        expanded={panel === "items"} controls="v2-basket-panel-items" onClick={() => onPanel(panel === "items" ? null : "items")} />
      <Tool icon={<QuantityIcon />} label="Quantités" disabled={readOnly} title={readOnly ? OFFLINE_TITLE : advanced ? "Panier avancé activé : une quantité par article" : "Activer le panier avancé : une quantité par article"}
        active={advanced} pressed={advanced} onClick={() => onAdvanced(!advanced)} />
      <Tool icon={<UnitPriceIcon />} label="Prix à l’unité" disabled={readOnly}
        title={readOnly ? OFFLINE_TITLE : unitMode ? "Comparaison au prix à l’unité (par kg, L ou pièce) : cliquez pour revenir au prix à payer"
          : "Comparer au prix à l’unité (par kg, L ou pièce) plutôt qu’au prix à payer"}
        active={unitMode} pressed={unitMode} onClick={() => onUnitMode(!unitMode)} />
      <Tool icon={<FilterIcon />} label="Magasins" detail={filterCount ? String(filterCount) : undefined} disabled={!filtersAvailable || readOnly}
        title={readOnly ? OFFLINE_TITLE : filtersAvailable ? "Filtrer les magasins comparés" : "Récupérez d’abord les prix pour filtrer les magasins"}
        active={panel === "filters" || filterCount > 0} expanded={panel === "filters"} controls="v2-basket-panel-filters"
        onClick={() => onPanel(panel === "filters" ? null : "filters")} />
      {shareable && <Tool icon={<ShareIcon />} label="Partager" title={readOnly ? OFFLINE_TITLE : "Partager le panier"} disabled={readOnly} active={panel === "share"}
        expanded={panel === "share"} controls="v2-basket-panel-share" onClick={() => onPanel(panel === "share" ? null : "share")} />}
    </div>
    {action}
  </div>;
}
