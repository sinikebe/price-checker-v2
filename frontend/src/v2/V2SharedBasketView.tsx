import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import V2BasketResults from "./V2BasketResults";
import V2ShoppingList from "./V2ShoppingList";
import { useBasketComparison } from "./useBasketComparison";
import { useBasketView } from "./useBasketView";
import { BasketLinksContext } from "./v2-basket-links";
import { BasketReadOnlyContext } from "./v2-basket-read-only";
import { basketQuantityLabel } from "./v2-basket-share-labels";
import { basketItemKey, isPriceable } from "./v2-basket-storage";
import { FIRST_STORES, MORE_STORES, comparisonTitle, fetchedLabel, itemKind, itemName, selectionSummary } from "./v2-basket-view";
import { viewSharedBasket } from "./v2-shared-basket-api";
import { SHARED_BASKET_PATH, keepPendingInvite, sharedItems, sharedSettings, sharedSnapshot, type SharedView } from "./v2-shared-basket";
import "./v2-shared-basket.css";

const NO_CHANGE = () => undefined;

/**
 * A shared basket opened from its link by someone not signed in: its articles, its list and the prices a
 * member fetched, read only. Signing in lets the visitor join it and change it with its members.
 */
export default function V2SharedBasketView({ invite }: { invite: string }) {
  const [view, setView] = useState<SharedView | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<"basket" | "list">("basket");
  const [shown, setShown] = useState(FIRST_STORES);
  useEffect(() => {
    const controller = new AbortController();
    viewSharedBasket(invite, controller.signal).then(value => { setView(value); setError(""); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Panier partagé indisponible."); });
    return () => controller.abort();
  }, [invite, attempt]);
  const base = useMemo(() => view ? sharedItems(view.lines) : null, [view]);
  const items = useMemo(() => base?.items ?? [], [base]);
  const settings = useMemo(() => sharedSettings(view), [view]);
  const display = useBasketView(null, { settings, setSettings: NO_CHANGE });
  const activeItems = useMemo(() => items.filter(item => !item.disabled), [items]);
  const priceItems = useMemo(() => activeItems.filter(isPriceable), [activeItems]);
  const snapshot = useMemo(() => view?.prices ? sharedSnapshot(view.prices, view.lines, basketItemKey, { userId: 0, basketId: 0 }) : null, [view]);
  const { comparison, split, savings, lineItems, offStores, hasOpenPrices, view: priced } = useBasketComparison(snapshot, priceItems, display);
  const join = <Link className="v2-button v2-button-primary" to="/v2/connexion?next=panier" onClick={() => keepPendingInvite(invite)}>Se connecter pour rejoindre</Link>;

  if (error) return <section className="v2-shared-basket v2-shared-join" aria-label="Panier partagé">
    <h2>Panier partagé</h2><p role="alert">{error}</p>
    <button type="button" className="v2-button v2-button-secondary" onClick={() => setAttempt(value => value + 1)}>Réessayer</button>
  </section>;
  if (!view) return <p role="status">Ouverture du panier partagé…</p>;
  const texts = activeItems.filter(item => !isPriceable(item));
  return <BasketReadOnlyContext.Provider value="view"><BasketLinksContext.Provider value={true}>
    <section className="v2-shared-banner v2-shared-view" aria-label="Panier partagé">
      <div className="v2-shared-banner-head">
        <div>
          <span className="v2-section-kicker">PANIER PARTAGÉ · LECTURE SEULE</span>
          <h2>{view.name}</h2>
          <p>Vous voyez ce panier grâce à son lien. Connectez-vous pour le rejoindre : vous pourrez alors le modifier et cocher sa liste avec ses membres.</p>
        </div>
        <div className="v2-shared-banner-actions">{join}
          <button type="button" className="v2-button v2-button-secondary" onClick={() => setAttempt(value => value + 1)}>Actualiser</button></div>
      </div>
    </section>
    <div className="v2-shared-view-tabs" role="group" aria-label="Affichage">
      <button type="button" aria-pressed={tab === "basket"} onClick={() => setTab("basket")}>Articles et prix</button>
      <button type="button" aria-pressed={tab === "list"} onClick={() => setTab("list")}>Liste de courses</button>
    </div>
    {tab === "list" ? <V2ShoppingList view={display.listView} onView={NO_CHANGE} items={display.listView.kind === "all" ? activeItems : [...lineItems, ...texts]}
      comparison={comparison} split={split} storesOff={display.storesOff} advanced={display.advanced} checked={display.checked} onChecked={NO_CHANGE}
      basePath={SHARED_BASKET_PATH} sharedName={view.name}
      fetchHint="Aucun prix n’a encore été récupéré pour ce panier : la répartition entre magasins apparaît dès qu’un membre les récupère." />
      : <>
        <section className="v2-basket-panel" aria-label="Articles du panier">
          <ul className="v2-shared-view-items">{items.map(item => <li key={basketItemKey(item)} data-disabled={item.disabled ? "true" : "false"}>
            <span className="v2-basket-item-kind">{itemKind(item)}</span><strong>{itemName(item)}</strong>
            <small>{["kind" in item && item.kind === "selection" ? selectionSummary(item) : null, display.advanced && item.quantity ? basketQuantityLabel(item.quantity) : null,
              item.disabled ? "exclu du calcul" : null].filter(Boolean).join(" · ")}</small>
          </li>)}</ul>
        </section>
        <section className="v2-basket-comparison v2-recipes-card" aria-label="Comparaison des prix">
          {!snapshot || !priceItems.length ? <><h2>Comparer les prix</h2>
            <p>{priceItems.length ? "Aucun prix n’a encore été récupéré pour ce panier. Un membre connecté peut les récupérer avec ses crédits : tout le monde les voit ensuite." : "Ce panier n’a pas encore d’article à comparer."}</p></>
            : <>
              <div className="v2-basket-comparison-heading"><div><h2>{comparisonTitle(display.mode, display.advanced)}</h2>
                <p>Prix récupérés le {fetchedLabel(snapshot.fetchedAt)} par un membre du panier. Déplacement et frais de livraison exclus.</p>
                <button type="button" className="v2-button v2-button-secondary v2-list-entry" onClick={() => setTab("list")}>Liste de courses →</button></div></div>
              {priced.stale.length > 0 && <p className="v2-basket-stale" role="status">Pas encore dans le relevé de prix : {priced.stale.map(itemName).join(", ")}.</p>}
              {comparison && split && <V2BasketResults comparison={comparison} split={split} offStores={offStores} onStoreActive={NO_CHANGE} items={lineItems}
                advanced={display.advanced} mode={display.mode} limited={priced.limited.length} shownCount={shown} onShowMore={() => setShown(shown + MORE_STORES)}
                openPrices={hasOpenPrices} savings={savings} onUnit={NO_CHANGE} onList={() => setTab("list")} />}
            </>}
        </section>
      </>}
  </BasketLinksContext.Provider></BasketReadOnlyContext.Provider>;
}
