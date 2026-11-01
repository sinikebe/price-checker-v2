import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CreditIcon, FilterIcon, ListIcon, QuantityIcon, RefreshIcon, ShareIcon, UnitPriceIcon } from "./V2SiteIcons";
import { creditLabel, nextGrantLabel, outOfCredits, type BasketCredits } from "./v2-basket-credits-api";

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

/** Icon buttons for the basket tools, and the paid action that fetches the prices. */
export default function V2BasketToolbar({ panel, onPanel, itemCount, activeCount, advanced, onAdvanced, unitMode, onUnitMode, filterCount, filtersAvailable,
  signedIn, credits, hasPrices, fetching, onFetch }: {
  panel: BasketPanel | null; onPanel: (panel: BasketPanel | null) => void; itemCount: number; activeCount: number;
  advanced: boolean; onAdvanced: (value: boolean) => void; unitMode: boolean; onUnitMode: (value: boolean) => void; filterCount: number; filtersAvailable: boolean;
  signedIn: boolean; credits: BasketCredits | null; hasPrices: boolean; fetching: boolean; onFetch: () => void;
}) {
  const empty = outOfCredits(credits);
  const unlimited = credits?.unlimited === true;
  const creditTitle = unlimited ? "Crédits illimités pour les administrateurs."
    : credits
      ? `${creditLabel(credits.balance)} restant${credits.balance > 1 ? "s" : ""}. ${credits.daily_grant} par jour, ${credits.weekly_max} par semaine au maximum.`
      : "Chaque compte reçoit des crédits chaque jour.";
  return <div className="v2-basket-toolbar" role="group" aria-label="Outils du panier">
    <div className="v2-basket-tools">
      <Tool icon={<ListIcon />} label="Articles" detail={`${activeCount}/${itemCount}`} title="Articles du panier" active={panel === "items"}
        expanded={panel === "items"} controls="v2-basket-panel-items" onClick={() => onPanel(panel === "items" ? null : "items")} />
      <Tool icon={<QuantityIcon />} label="Quantités" title={advanced ? "Panier avancé activé : une quantité par article" : "Activer le panier avancé : une quantité par article"}
        active={advanced} pressed={advanced} onClick={() => onAdvanced(!advanced)} />
      <Tool icon={<UnitPriceIcon />} label="Prix à l’unité"
        title={unitMode ? "Comparaison au prix à l’unité (par kg, L ou pièce) : cliquez pour revenir au prix à payer"
          : "Comparer au prix à l’unité (par kg, L ou pièce) plutôt qu’au prix à payer"}
        active={unitMode} pressed={unitMode} onClick={() => onUnitMode(!unitMode)} />
      <Tool icon={<FilterIcon />} label="Magasins" detail={filterCount ? String(filterCount) : undefined} disabled={!filtersAvailable}
        title={filtersAvailable ? "Filtrer les magasins comparés" : "Récupérez d’abord les prix pour filtrer les magasins"}
        active={panel === "filters" || filterCount > 0} expanded={panel === "filters"} controls="v2-basket-panel-filters"
        onClick={() => onPanel(panel === "filters" ? null : "filters")} />
      <Tool icon={<ShareIcon />} label="Partager" title="Partager le panier" active={panel === "share"}
        expanded={panel === "share"} controls="v2-basket-panel-share" onClick={() => onPanel(panel === "share" ? null : "share")} />
    </div>
    {signedIn ? <div className="v2-basket-fetch">
      <span className="v2-basket-credits" title={creditTitle} data-empty={empty}><CreditIcon /><span>{unlimited ? <>∞<span className="v2-basket-credits-word"> crédits illimités</span></>
        : credits ? <>{credits.balance}<span className="v2-basket-credits-word"> crédit{credits.balance > 1 ? "s" : ""}</span></> : "Crédits"}</span></span>
      <button type="button" className="v2-button v2-button-primary" disabled={fetching || empty} onClick={onFetch}
        title={empty && credits ? `Plus de crédit. Prochain crédit ${nextGrantLabel(credits.next_grant_on)}.` : unlimited ? "Récupérer les prix actuels : sans limite pour un administrateur" : "Récupérer les prix actuels : 1 crédit"}>
        <RefreshIcon />{fetching ? "Récupération…" : hasPrices ? "Actualiser" : "Comparer les prix"}<small>{unlimited ? "illimité" : "1 crédit"}</small>
      </button>
    </div> : <Link className="v2-button v2-button-primary" to="/v2/connexion?next=panier">Se connecter pour comparer</Link>}
  </div>;
}
