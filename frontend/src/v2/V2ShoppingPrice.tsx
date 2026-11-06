import { usePaidPrices } from "./usePaidPrices";
import { useSiteFilter } from "./useSiteFilter";
import { passesSiteFilter } from "./v2-site-filter";
import { creditLabel } from "./v2-basket-credits-api";
import { bestPrice, readingPlace, type LatestReading } from "./v2-product-best-price";
import { money } from "./v2-basket-view";

type Prices = { latest_by_store: LatestReading[] };
const day = (value: string) => new Date(value + "T12:00:00").toLocaleDateString("fr-FR");

/**
 * Shopping mode: the lowest known price of a product. Shown from this device when its prices were
 * already fetched; otherwise fetched on request, for the usual credit.
 */
export default function V2ShoppingPrice({ productId, userId }: { productId: number; userId: number | null }) {
  const paid = usePaidPrices<Prices>(userId, "product", String(productId), 1, () => `/api/v2/prices/products/${productId}`);
  // The account's site-wide store filter, when on, keeps the stores it names.
  const site = useSiteFilter().active;
  const best = paid.data ? bestPrice(paid.data.latest_by_store.filter(row => passesSiteFilter(row, site))) : null;
  return <div className="v2-shopping-price" aria-live="polite">
    {paid.data ? best ? <p><strong>À partir de {money(best.cents)}</strong>
      <small>{readingPlace(best.reading)} · relevé le {day(best.reading.observed_at)}{best.stores > 1 ? ` · ${best.stores} magasins relevés` : ""}</small></p>
      : <p>{site ? "Aucun prix relevé dans les magasins du filtre du site." : "Aucun prix relevé pour ce produit."}</p>
      : <button type="button" className="v2-button v2-button-secondary" disabled={paid.busy} onClick={() => { void paid.pay(); }}>
        {paid.busy ? "Chargement…" : `Voir le prix · ${creditLabel(paid.cost)}`}</button>}
    {paid.error && <p role="alert">{paid.error}</p>}
  </div>;
}
