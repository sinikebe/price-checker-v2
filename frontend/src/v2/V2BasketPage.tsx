import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useV2Basket } from "./V2BasketContext";
import { buildBasketComparison, type BasketPrice, type BasketPriceResponse, type PriceChoice } from "./v2-basket-comparison";
import type { BasketProduct } from "./v2-basket-storage";
import type { V2User } from "./v2-auth-api";
import "./v2-recipes.css";
import "./v2-basket.css";

type ComparisonView = "stores" | "split" | null;
type PriceSnapshot = { key: string; responses: Map<number, BasketPriceResponse | null> };
const channelNames: Record<BasketPrice["sales_channel"], string> = {
  in_store: "En magasin", drive: "Drive", delivery: "Livraison",
};
const money = (cents: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(cents / 100);
const productName = (product: BasketProduct) => [product.data.brand, product.data.name].filter(Boolean).join(" ");
const date = (value: string) => new Date(value + "T12:00:00").toLocaleDateString("fr-FR", {
  day: "numeric", month: "short", year: "numeric",
});
function freshness(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const now = new Date();
  const age = Math.max(0, Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
    - Date.UTC(year, month - 1, day)) / 86400000));
  if (!Number.isFinite(age)) return { code: "old", label: "Date à vérifier" };
  if (age <= 30) return { code: "recent", label: "Récent" };
  if (age <= 90) return { code: "aging", label: "À vérifier" };
  return { code: "old", label: "Ancien" };
}
function storeName(row: BasketPrice) {
  return [row.store_name, row.city, row.postal_code, channelNames[row.sales_channel]].filter(Boolean).join(" · ");
}
function DatedPrice({ choice }: { choice: PriceChoice }) {
  const age = freshness(choice.reading.observed_at);
  return <span className="v2-basket-reading">
    <strong>{money(choice.cents)}</strong>
    <small>Relevé du {date(choice.reading.observed_at)}</small>
    <span className="v2-basket-age" data-age={age.code}>{age.label}</span>
  </span>;
}

export default function V2BasketPage({ user, onLogout }: { user: V2User | null; onLogout: () => Promise<void> }) {
  const { products, remove, clear } = useV2Basket();
  const [view, setView] = useState<ComparisonView>(null);
  const [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<PriceSnapshot | null>(null);
  const active = view !== null;
  const key = products.map(product => product.id).join(",") + ":" + refresh;
  const ready = snapshot?.key === key;

  useEffect(() => {
    if (!active || products.length === 0) return;
    const controller = new AbortController();
    const responses = new Map<number, BasketPriceResponse | null>();
    let index = 0;
    async function worker() {
      while (index < products.length && !controller.signal.aborted) {
        const product = products[index++];
        try {
          const response = await fetch("/api/v2/prices/products/" + product.id, {
            credentials: "same-origin", cache: "no-store", signal: controller.signal,
          });
          if (!response.ok) throw new Error("Prix indisponibles");
          responses.set(product.id, await response.json() as BasketPriceResponse);
        } catch {
          if (!controller.signal.aborted) responses.set(product.id, null);
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, products.length) }, () => worker()))
      .then(() => { if (!controller.signal.aborted) setSnapshot({ key, responses }); });
    return () => controller.abort();
  }, [active, key, products]);

  const comparison = ready && snapshot ? buildBasketComparison(products, snapshot.responses) : null;
  const hasOpenPrices = comparison?.stores.some(store => store.choices.some(choice =>
    choice.reading.source_provider === "open_prices")) ?? false;
  const splitStores = new Map<string, PriceChoice[]>();
  for (const choice of comparison?.split ?? []) {
    const storeKey = choice.reading.store_id + ":" + choice.reading.sales_channel;
    const current = splitStores.get(storeKey) ?? [];
    current.push(choice);
    splitStores.set(storeKey, current);
  }

  return <div className="v2-home v2-recipes">
    <a className="v2-skip" href="#v2-basket-main">Aller au contenu</a>
    <header className="v2-header"><div className="v2-wrap v2-header-inner">
      <Link className="v2-brand" to="/v2">price<span className="v2-brand-accent">checker</span>.</Link>
      <nav className="v2-nav" aria-label="Navigation principale"><Link to="/v2">Accueil</Link><Link to="/v2/produits">Produits</Link><Link to="/v2/recettes">Recettes</Link><Link className="v2-nav-current" to="/v2/panier" aria-current="page">Panier</Link><Link to="/v2/parametres">Paramètres</Link>{user ? <button type="button" onClick={() => void onLogout()}>Déconnexion</button> : <Link to="/v2/connexion">Connexion</Link>}</nav>
    </div></header>
    <main id="v2-basket-main" className="v2-wrap v2-recipes-main">
      <div className="v2-recipes-heading"><div><span className="v2-section-kicker">VOS COURSES</span><h1>Mon panier<span>.</span></h1><p>Enregistré sur cet appareil et disponible hors ligne. Chaque produit compte pour un exemplaire.</p></div><Link className="v2-button v2-button-secondary" to="/v2/produits">Choisir des produits →</Link></div>
      {products.length ? <>
        <div className="v2-basket-actions" aria-label="Comparer le panier">
          <button type="button" className="v2-button v2-button-secondary" aria-pressed={view === "stores"}
            onClick={() => setView(view === "stores" ? null : "stores")}>Prix par magasin</button>
          <button type="button" className="v2-button v2-button-secondary" aria-pressed={view === "split"}
            onClick={() => setView(view === "split" ? null : "split")}>Panier réparti au prix le plus bas</button>
        </div>
        {active && <section className="v2-basket-comparison v2-recipes-card" aria-live="polite">
          <div className="v2-basket-comparison-heading">
            <div><h2>{view === "stores" ? "Comparer les magasins" : "Répartir au prix le plus bas"}</h2>
              <p>Derniers prix publiés par produit, point de vente et canal. Les prix peuvent avoir changé ; déplacement et livraison non inclus.</p></div>
            <button type="button" className="v2-button v2-button-secondary" onClick={() => setRefresh(value => value + 1)}>Actualiser les prix</button>
          </div>
          {!comparison && <p>Chargement des prix…</p>}
          {comparison && <>
            {comparison.failed.length > 0 && <p className="v2-recipes-error">Prix impossibles à charger pour {comparison.failed.length} produit{comparison.failed.length > 1 ? "s" : ""}. Réessayez d’actualiser.</p>}
            {comparison.truncated.length > 0 && <p className="v2-recipes-error">Certains points de vente n’ont pas pu être comparés : limite de 200 par produit. Le minimum affiché peut être incomplet.</p>}
            {view === "stores" && (comparison.stores.length
              ? <ul className="v2-basket-store-list">{comparison.stores.map(store => {
                const complete = store.coverage === products.length;
                return <li key={store.key} className="v2-basket-store">
                  <div className="v2-basket-store-heading"><div><h3>{store.reading.retailer}</h3><p>{storeName(store.reading)}</p></div>
                    <div className="v2-basket-total"><strong>{money(store.cents)}</strong><span>{complete ? "Panier complet" : "Sous-total partiel"} · {store.coverage}/{products.length} produits</span></div></div>
                  <ul className="v2-basket-lines">{store.choices.map(choice => <li key={choice.product.id}>
                    <Link to={"/v2/produits/" + choice.product.id}>{productName(choice.product)}</Link><DatedPrice choice={choice} />
                  </li>)}</ul>
                  {!complete && <p className="v2-basket-missing">Sans prix dans ce point de vente : {products.filter(product =>
                    !store.choices.some(choice => choice.product.id === product.id)).map(productName).join(", ")}.</p>}
                </li>;
              })}</ul>
              : <p>Aucun prix comparable n’est disponible pour ce panier.</p>)}
            {view === "split" && <>
              <div className="v2-basket-split-total"><span>{comparison.missing.length ? "Sous-total des articles avec prix" : "Total du panier réparti"}</span>
                <strong>{comparison.split.length ? money(comparison.splitCents) : "—"}</strong>
                <small>{comparison.split.length}/{products.length} produits avec un prix</small></div>
              {splitStores.size > 0 && <ul className="v2-basket-store-list">{[...splitStores].map(([storeKey, choices]) => {
                const reading = choices[0].reading;
                return <li key={storeKey} className="v2-basket-store"><div className="v2-basket-store-heading">
                  <div><h3>{reading.retailer}</h3><p>{storeName(reading)}</p></div>
                  <div className="v2-basket-total"><strong>{money(choices.reduce((sum, choice) => sum + choice.cents, 0))}</strong><span>{choices.length} produit{choices.length > 1 ? "s" : ""}</span></div>
                </div><ul className="v2-basket-lines">{choices.map(choice => <li key={choice.product.id}>
                  <Link to={"/v2/produits/" + choice.product.id}>{productName(choice.product)}</Link><DatedPrice choice={choice} />
                </li>)}</ul></li>;
              })}</ul>}
              {comparison.missing.length > 0 && <p className="v2-basket-missing">Sans prix comparable : {comparison.missing.map(productName).join(", ")}. Aucun total complet n’est calculé.</p>}
            </>}
            {hasOpenPrices && <p className="v2-basket-freshness-help">Certains relevés proviennent de <a href="https://prices.openfoodfacts.org" target="_blank" rel="noreferrer">Open Prices / Open Food Facts (ODbL)</a>.</p>}
            <p className="v2-basket-freshness-help">Fraîcheur des relevés : vert ≤ 30 jours, orange 31 à 90 jours, gris au-delà. Les relevés indisponibles ou contestés sont exclus.</p>
          </>}
        </section>}
        <ul className="v2-recipes-list">{products.map(product => <li className="v2-recipes-tile" key={product.id}><Link to={"/v2/produits/" + product.id}><strong>{productName(product)}</strong></Link><span>{product.data.quantity || "Quantité non précisée"} · {product.data.group || "Sans groupe"}</span><button type="button" className="v2-button v2-button-secondary" onClick={() => remove(product.id)}>Retirer</button></li>)}</ul>
        <button type="button" className="v2-button v2-button-secondary v2-basket-clear" onClick={() => { if (window.confirm("Vider le panier ?")) clear(); }}>Vider le panier</button>
      </> : <div className="v2-recipes-card"><p>Votre panier est vide pour le moment.</p></div>}
    </main>
  </div>;
}
