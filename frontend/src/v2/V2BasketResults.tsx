import V2BasketLines from "./V2BasketLines";
import { basketItemKey, type BasketItem } from "./v2-basket-storage";
import { pricePosition, purchaseTotalCents, type BasketComparison, type PriceChoice } from "./v2-basket-comparison";
import { itemName, money, storeName } from "./v2-basket-view";

/** The split across retailers, then the cheapest stores. Everything is computed from the fetched prices. */
export default function V2BasketResults({ comparison, items, advanced, limited, shownCount, onShowMore, openPrices }: {
  comparison: BasketComparison; items: BasketItem[]; advanced: boolean; limited: number;
  shownCount: number; onShowMore: () => void; openPrices: boolean;
}) {
  const lineCount = items.length;
  const splitStores = new Map<string, PriceChoice[]>();
  for (const choice of comparison.split) {
    const storeKey = choice.reading.store_id + ":" + choice.reading.sales_channel;
    splitStores.set(storeKey, [...(splitStores.get(storeKey) ?? []), choice]);
  }
  const itemRanges = new Map<string, { min: number; max: number }>();
  const totalRanges = new Map<number, { min: number; max: number }>();
  for (const store of comparison.stores) {
    const total = totalRanges.get(store.coverage);
    totalRanges.set(store.coverage, { min: Math.min(total?.min ?? store.cents, store.cents), max: Math.max(total?.max ?? store.cents, store.cents) });
    for (const choice of store.choices) {
      const key = basketItemKey(choice.item);
      const range = itemRanges.get(key);
      itemRanges.set(key, { min: Math.min(range?.min ?? choice.cents, choice.cents), max: Math.max(range?.max ?? choice.cents, choice.cents) });
    }
  }
  const rangeFor = (choice: PriceChoice) => itemRanges.get(basketItemKey(choice.item)) ?? { min: choice.cents, max: choice.cents };
  const visibleStores = comparison.stores.slice(0, shownCount);
  const missingNames = (items: BasketItem[]) => items.map(itemName).join(", ");
  const incomplete = comparison.truncated.length + limited > 0;

  return <>
    {comparison.failed.length > 0 && <p className="v2-recipes-error">Prix impossibles à charger pour {comparison.failed.length} article{comparison.failed.length > 1 ? "s" : ""}. Actualisez pour réessayer.</p>}
    {incomplete && <p className="v2-recipes-error">Certains points de vente n’ont pas pu être comparés : limite de taille atteinte. {advanced ? "L’estimation affichée peut être incomplète." : "Le minimum affiché peut être incomplet."}</p>}
    <section className="v2-basket-split-total" aria-label="Répartition des courses entre enseignes" aria-live="polite">
      <span>{comparison.missing.length ? "Sous-total réparti des articles avec prix" : advanced ? "Coût estimé de la sélection répartie" : "Total le moins cher en répartissant les courses"}</span>
      <strong>{comparison.split.length ? money(comparison.splitCents) : "—"}</strong>
      {advanced && comparison.split.length > 0 && <span>{comparison.missing.length ? "Sous-total de la part utilisée" : "Part utilisée au prorata"} : <strong>{money(comparison.splitUsedCents)}</strong></span>}
      <small>{comparison.split.length}/{lineCount} articles avec un prix · {splitStores.size} point{splitStores.size > 1 ? "s" : ""} de vente</small>
      {splitStores.size > 0 && <ul className="v2-basket-split-stores">{[...splitStores].map(([storeKey, choices]) => {
        const reading = choices[0].reading;
        return <li key={storeKey}><details className="v2-basket-breakdown">
          <summary><span className="v2-basket-split-store-name"><b>{reading.retailer}</b><small>{storeName(reading)}</small></span>
            <span className="v2-basket-split-store-total"><b>{money(purchaseTotalCents(choices, advanced))}</b><small>{choices.length} article{choices.length > 1 ? "s" : ""}</small></span></summary>
          {advanced && <p>Les prix par article sont indiqués avant mutualisation ; le total compte chaque paquet partagé une seule fois.</p>}
          <V2BasketLines choices={choices} advanced={advanced} rangeFor={rangeFor} />
        </details></li>;
      })}</ul>}
    </section>
    {comparison.missing.length > 0 && <p className="v2-basket-missing">Sans prix ou quantité de paquet compatible : {missingNames(comparison.missing)}. Aucun total complet n’est calculé.</p>}
    <div className="v2-basket-results-heading"><h3>{visibleStores.length > 1 ? `Les ${Math.min(shownCount, comparison.stores.length)} magasins les moins chers` : "Le magasin le moins cher"}</h3>
      <p>Paniers complets classés par prix ; sous-totaux partiels ensuite.</p></div>
    {visibleStores.length ? <ul className="v2-basket-store-list">{visibleStores.map(store => {
      const complete = store.coverage === lineCount;
      return <li key={store.key} className="v2-basket-store" data-complete={complete}><div className="v2-basket-store-heading"><div><h4>{store.reading.retailer}</h4><p>{storeName(store.reading)}</p></div>
        <div className="v2-basket-total" data-price-position={complete ? pricePosition(store.cents, totalRanges.get(store.coverage)?.min ?? store.cents, totalRanges.get(store.coverage)?.max ?? store.cents) : "partial"}><strong>{money(store.cents)}</strong>{advanced && <span>{complete ? "Part utilisée" : "Sous-total de la part utilisée"} : {money(store.choices.reduce((sum, choice) => sum + choice.usedCents, 0))}</span>}<span>{complete ? "Panier complet" : "Sous-total partiel"} · {store.coverage}/{lineCount} articles</span></div></div>
        <details className="v2-basket-breakdown"><summary>Voir les {store.coverage} prix</summary>{advanced && <p>Prix par article avant mutualisation des paquets.</p>}
          <V2BasketLines choices={store.choices} advanced={advanced} rangeFor={rangeFor} />
          {!complete && <p className="v2-basket-missing">Sans prix ici : {missingNames(items.filter(item => !store.choices.some(choice => basketItemKey(choice.item) === basketItemKey(item))))}.</p>}
        </details>
      </li>;
    })}</ul> : <p>Aucun prix comparable ne correspond à ce panier et à ces filtres.</p>}
    {comparison.stores.length > shownCount && <button type="button" className="v2-button v2-button-secondary v2-basket-load-more" onClick={onShowMore}>Voir d’autres magasins ({comparison.stores.length - shownCount})</button>}
    {openPrices && <p className="v2-basket-freshness-help">Certains relevés proviennent de <a href="https://prices.openfoodfacts.org" target="_blank" rel="noreferrer">Open Prices / Open Food Facts (ODbL)</a>.</p>}
    <p className="v2-basket-freshness-help">Montants : vert = bas, orange = intermédiaire, rouge = haut. Trait sous le prix : vert ≤ 30 jours, orange 31 à 90 jours, gris au-delà. Les relevés indisponibles ou contestés sont exclus.</p>
  </>;
}
