import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useV2Basket } from "./V2BasketContext";
import { basketItemKey, type BasketItem, type BasketProduct } from "./v2-basket-storage";
import { buildBasketComparison, emptyBasketFilters, postalDepartment,
  type BasketFilters, type BasketLine, type BasketPrice, type BasketPriceResponse, type PriceChoice } from "./v2-basket-comparison";
import type { V2User } from "./v2-auth-api";
import "./v2-recipes.css";
import "./v2-basket.css";

type ComparisonView = "stores" | "split" | null;
type PriceSnapshot = { key: string; lines: BasketLine[]; responses: Map<number, BasketPriceResponse | null> };
const channelNames: Record<BasketPrice["sales_channel"], string> = {
  in_store: "En magasin", drive: "Drive", delivery: "Livraison",
};
const money = (cents: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(cents / 100);
const productName = (product: BasketProduct) => [product.data.brand, product.data.name].filter(Boolean).join(" ");
const itemName = (item: BasketItem) => "kind" in item ? item.name : productName(item);
const itemKind = (item: BasketItem) => "kind" in item ? item.kind === "group" ? "Groupe comparable" : "Ensemble" : "Produit";
function itemHref(item: BasketItem) {
  if (!("kind" in item)) return "/v2/produits/" + item.id;
  if (item.kind === "group") return "/v2/categories/" + encodeURIComponent(item.name);
  return "/v2/produits?" + new URLSearchParams({ rayon: item.department, famille: item.family, ensemble: item.name });
}
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
function ChoiceLabel({ choice }: { choice: PriceChoice }) {
  return <span className="v2-basket-choice"><Link to={itemHref(choice.item)}>{itemName(choice.item)}</Link>
    {"kind" in choice.item && <small>Choix : <Link to={"/v2/produits/" + choice.product.id}>{productName(choice.product)}</Link>
      {choice.product.data.quantity && " · " + choice.product.data.quantity}</small>}</span>;
}
async function fetchCandidates(item: BasketItem, signal: AbortSignal): Promise<BasketProduct[]> {
  if (!("kind" in item)) return [item];
  const path = item.kind === "group" ? "/categories/" + encodeURIComponent(item.name)
    : "/comparison?" + new URLSearchParams({ department: item.department, family: item.family, scope: item.name });
  const response = await fetch("/api/v2/catalogue" + path, { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new Error("Article introuvable");
  const detail = await response.json() as { products: BasketProduct[] };
  return detail.products;
}
function MultiFilter<T extends string | number>({ title, options, selected, onChange, label }: {
  title: string; options: T[]; selected: T[]; onChange: (next: T[]) => void; label: (value: T) => string;
}) {
  return <details className="v2-basket-filter"><summary>{title}{selected.length ? ` · ${selected.length}` : " · Tous"}</summary>
    <div className="v2-basket-filter-options">{options.length ? options.map(value => <label key={value}>
      <input type="checkbox" checked={selected.includes(value)} onChange={event => onChange(event.target.checked
        ? [...selected, value] : selected.filter(item => item !== value))} />{label(value)}</label>) : <p>Aucune option disponible.</p>}</div>
  </details>;
}

export default function V2BasketPage({ user, onLogout }: { user: V2User | null; onLogout: () => Promise<void> }) {
  const { items, remove, clear } = useV2Basket();
  const [view, setView] = useState<ComparisonView>(null);
  const [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<PriceSnapshot | null>(null);
  const [filters, setFilters] = useState<BasketFilters>(emptyBasketFilters);
  const active = view !== null;
  const key = items.map(basketItemKey).join("|") + ":" + refresh;
  const ready = snapshot?.key === key;

  useEffect(() => {
    if (!active || items.length === 0) return;
    const controller = new AbortController();
    async function load() {
      const lines = await Promise.all(items.map(async item => {
        try { return { item, candidates: await fetchCandidates(item, controller.signal) }; }
        catch { return { item, candidates: [] }; }
      }));
      const products = [...new Map(lines.flatMap(line => line.candidates).map(product => [product.id, product])).values()];
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
          } catch { if (!controller.signal.aborted) responses.set(product.id, null); }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, products.length) }, () => worker()));
      if (!controller.signal.aborted) setSnapshot({ key, lines, responses });
    }
    void load();
    return () => controller.abort();
  }, [active, key, items]);

  const comparison = ready && snapshot ? buildBasketComparison(snapshot.lines, snapshot.responses, filters) : null;
  const availableRows = ready && snapshot ? [...snapshot.responses.values()].flatMap(response => response?.latest_by_store ?? []) : [];
  const storeNames = new Map<number, string>();
  for (const row of availableRows) storeNames.set(row.store_id, [row.retailer, row.store_name, row.city].filter(Boolean).join(" · "));
  const storeOptions = [...storeNames.keys()].sort((a, b) => (storeNames.get(a) ?? "").localeCompare(storeNames.get(b) ?? "", "fr"));
  const cityOptions = [...new Set(availableRows.map(row => row.city?.trim()).filter((value): value is string => !!value))].sort((a, b) => a.localeCompare(b, "fr"));
  const departmentOptions = [...new Set(availableRows.map(row => postalDepartment(row.postal_code)).filter((value): value is string => !!value))].sort((a, b) => a.localeCompare(b, "fr"));
  const hasOpenPrices = comparison?.stores.some(store => store.choices.some(choice =>
    choice.reading.source_provider === "open_prices")) ?? false;
  const splitStores = new Map<string, PriceChoice[]>();
  for (const choice of comparison?.split ?? []) {
    const storeKey = choice.reading.store_id + ":" + choice.reading.sales_channel;
    const current = splitStores.get(storeKey) ?? [];
    current.push(choice);
    splitStores.set(storeKey, current);
  }
  const anyFilter = filters.storeIds.length + filters.cities.length + filters.departments.length > 0;

  return <div className="v2-home v2-recipes">
    <a className="v2-skip" href="#v2-basket-main">Aller au contenu</a>
    <header className="v2-header"><div className="v2-wrap v2-header-inner">
      <Link className="v2-brand" to="/v2">price<span className="v2-brand-accent">checker</span>.</Link>
      <nav className="v2-nav" aria-label="Navigation principale"><Link to="/v2">Accueil</Link><Link to="/v2/produits">Produits</Link><Link to="/v2/recettes">Recettes</Link><Link className="v2-nav-current" to="/v2/panier" aria-current="page">Panier</Link><Link to="/v2/parametres">Paramètres</Link>{user ? <button type="button" onClick={() => void onLogout()}>Déconnexion</button> : <Link to="/v2/connexion">Connexion</Link>}</nav>
    </div></header>
    <main id="v2-basket-main" className="v2-wrap v2-recipes-main">
      <div className="v2-recipes-heading"><div><span className="v2-section-kicker">VOS COURSES</span><h1>Mon panier<span>.</span></h1><p>Enregistré sur cet appareil et disponible hors ligne. Chaque article représente un exemplaire : produit précis, ou choix parmi les produits d’un groupe ou d’un ensemble.</p></div><Link className="v2-button v2-button-secondary" to="/v2/produits">Ajouter depuis le catalogue →</Link></div>
      {items.length ? <>
        <div className="v2-basket-actions" aria-label="Comparer le panier">
          <button type="button" className="v2-button v2-button-secondary" aria-pressed={view === "stores"}
            onClick={() => setView(view === "stores" ? null : "stores")}>Prix par magasin</button>
          <button type="button" className="v2-button v2-button-secondary" aria-pressed={view === "split"}
            onClick={() => setView(view === "split" ? null : "split")}>Panier réparti au prix le plus bas</button>
        </div>
        {active && <section className="v2-basket-comparison v2-recipes-card" aria-live="polite">
          <div className="v2-basket-comparison-heading">
            <div><h2>{view === "stores" ? "Comparer les magasins" : "Répartir au prix le plus bas"}</h2>
              <p>Derniers prix publiés par produit, point de vente et canal. Pour un groupe ou ensemble, le produit au prix total le plus bas est choisi ; sa quantité est indiquée. Les prix peuvent avoir changé ; déplacement et livraison non inclus.</p></div>
            <button type="button" className="v2-button v2-button-secondary" onClick={() => setRefresh(value => value + 1)}>Actualiser les prix</button>
          </div>
          {!ready && <p>Chargement des prix…</p>}
          {ready && <div className="v2-basket-filters" aria-label="Filtrer les magasins comparés">
            <h3>Filtrer les résultats</h3><p>Plusieurs choix possibles dans chaque filtre. Les types de filtres se cumulent.</p>
            <div className="v2-basket-filter-grid">
              <MultiFilter title="Magasins" options={storeOptions} selected={filters.storeIds} onChange={storeIds => setFilters({ ...filters, storeIds })} label={id => storeNames.get(id) ?? String(id)} />
              <MultiFilter title="Communes" options={cityOptions} selected={filters.cities} onChange={cities => setFilters({ ...filters, cities })} label={city => city} />
              <MultiFilter title="Départements" options={departmentOptions} selected={filters.departments} onChange={departments => setFilters({ ...filters, departments })} label={department => department} />
            </div>
            {anyFilter && <button type="button" className="v2-button v2-button-secondary" onClick={() => setFilters(emptyBasketFilters)}>Effacer les filtres</button>}
          </div>}
          {comparison && <>
            {comparison.failed.length > 0 && <p className="v2-recipes-error">Prix impossibles à charger pour {comparison.failed.length} article{comparison.failed.length > 1 ? "s" : ""}. Réessayez d’actualiser.</p>}
            {comparison.truncated.length > 0 && <p className="v2-recipes-error">Certains points de vente n’ont pas pu être comparés : limite de 200 par produit. Le minimum affiché peut être incomplet.</p>}
            {view === "stores" && (comparison.stores.length
              ? <ul className="v2-basket-store-list">{comparison.stores.map(store => {
                const complete = store.coverage === items.length;
                return <li key={store.key} className="v2-basket-store">
                  <div className="v2-basket-store-heading"><div><h3>{store.reading.retailer}</h3><p>{storeName(store.reading)}</p></div>
                    <div className="v2-basket-total"><strong>{money(store.cents)}</strong><span>{complete ? "Panier complet" : "Sous-total partiel"} · {store.coverage}/{items.length} articles</span></div></div>
                  <ul className="v2-basket-lines">{store.choices.map(choice => <li key={basketItemKey(choice.item)}>
                    <ChoiceLabel choice={choice} /><DatedPrice choice={choice} />
                  </li>)}</ul>
                  {!complete && <p className="v2-basket-missing">Sans prix dans ce point de vente : {items.filter(item =>
                    !store.choices.some(choice => basketItemKey(choice.item) === basketItemKey(item))).map(itemName).join(", ")}.</p>}
                </li>;
              })}</ul>
              : <p>Aucun prix comparable ne correspond à ce panier et à ces filtres.</p>)}
            {view === "split" && <>
              <div className="v2-basket-split-total"><span>{comparison.missing.length ? "Sous-total des articles avec prix" : "Total du panier réparti"}</span>
                <strong>{comparison.split.length ? money(comparison.splitCents) : "—"}</strong>
                <small>{comparison.split.length}/{items.length} articles avec un prix</small></div>
              {splitStores.size > 0 && <ul className="v2-basket-store-list">{[...splitStores].map(([storeKey, choices]) => {
                const reading = choices[0].reading;
                return <li key={storeKey} className="v2-basket-store"><div className="v2-basket-store-heading">
                  <div><h3>{reading.retailer}</h3><p>{storeName(reading)}</p></div>
                  <div className="v2-basket-total"><strong>{money(choices.reduce((sum, choice) => sum + choice.cents, 0))}</strong><span>{choices.length} article{choices.length > 1 ? "s" : ""}</span></div>
                </div><ul className="v2-basket-lines">{choices.map(choice => <li key={basketItemKey(choice.item)}>
                  <ChoiceLabel choice={choice} /><DatedPrice choice={choice} />
                </li>)}</ul></li>;
              })}</ul>}
              {comparison.missing.length > 0 && <p className="v2-basket-missing">Sans prix comparable : {comparison.missing.map(itemName).join(", ")}. Aucun total complet n’est calculé.</p>}
            </>}
            {hasOpenPrices && <p className="v2-basket-freshness-help">Certains relevés proviennent de <a href="https://prices.openfoodfacts.org" target="_blank" rel="noreferrer">Open Prices / Open Food Facts (ODbL)</a>.</p>}
            <p className="v2-basket-freshness-help">Fraîcheur des relevés : vert ≤ 30 jours, orange 31 à 90 jours, gris au-delà. Les relevés indisponibles ou contestés sont exclus.</p>
          </>}
        </section>}
        <ul className="v2-recipes-list">{items.map(item => <li className="v2-recipes-tile" key={basketItemKey(item)}><Link to={itemHref(item)}><strong>{itemName(item)}</strong></Link><span>{itemKind(item)}{"kind" in item ? item.kind === "scope" ? ` · ${item.department} / ${item.family}` : " · Choix parmi ce groupe" : ` · ${item.data.quantity || "Quantité non précisée"}`}</span><button type="button" className="v2-button v2-button-secondary" onClick={() => remove(item)}>Retirer</button></li>)}</ul>
        <button type="button" className="v2-button v2-button-secondary v2-basket-clear" onClick={() => { if (window.confirm("Vider le panier ?")) clear(); }}>Vider le panier</button>
      </> : <div className="v2-recipes-card"><p>Votre panier est vide pour le moment. Ajoutez un produit, un groupe comparable ou un ensemble depuis le catalogue.</p></div>}
    </main>
  </div>;
}
