import { useMemo, useState } from "react";
import { useConfirm } from "./useConfirm";
import { Link, useNavigate } from "react-router-dom";
import V2SiteHeader from "./V2SiteHeader";
import V2BasketFilters from "./V2BasketFilters";
import V2BasketItems from "./V2BasketItems";
import V2BasketResults from "./V2BasketResults";
import V2BasketToolbar, { type BasketPanel } from "./V2BasketToolbar";
import V2ShoppingList from "./V2ShoppingList";
import { FilterIcon, ListIcon, QuantityIcon, UnitPriceIcon } from "./V2SiteIcons";
import { useBasketComparison } from "./useBasketComparison";
import { useBasketDemo } from "./useBasketDemo";
import { useBasketView } from "./useBasketView";
import { useOnline } from "./useOnline";
import { BasketReadOnlyContext } from "./v2-basket-read-only";
import { reloadDemoSource, useDemoSource } from "./useDemoSource";
import { BasketLinksContext } from "./v2-basket-links";
import { DEMO_BASKET_PATH, type DemoSource } from "./v2-basket-demo";
import type { BaseUnit } from "./v2-basket-quantity";
import { basketItemKey, type BasketItem } from "./v2-basket-storage";
import { withStoreOff } from "./v2-basket-store-off";
import { FIRST_STORES, MORE_STORES, comparisonTitle, fetchedLabel } from "./v2-basket-view";
import { removeDemoBasket } from "./v2-demo-basket-api";
import { withUnitChoice } from "./v2-measures";
import { shoppingListPath, type ListView } from "./v2-shopping-list";
import type { V2User } from "./v2-auth-api";
import "./v2-recipes.css";
import "./v2-basket.css";
import "./v2-basket-demo.css";

const day = (value: string) => new Date(value).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

/** For administrators: where the demo comes from, how to replace it, and the way back to the app's example. */
function DemoAdmin({ source }: { source: DemoSource }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <section className="v2-demo-admin" aria-label="Panier de démonstration : administration">
    <p><strong>Administration.</strong> {source.fictional ? "C’est l’exemple intégré, avec des prix fictifs."
      : `Panier enregistré le ${day(source.savedAt!)}, avec les prix de ce jour-là.`} Pour le remplacer, ouvrez <Link to="/v2/panier">votre panier</Link>,
      puis <b>Partager → Panier de démonstration</b>.</p>
    {!source.fictional && <button type="button" className="v2-button v2-button-secondary" disabled={busy} onClick={async () => {
      if (!await confirm({ title: "Revenir à l’exemple intégré", message: "Revenir à l’exemple intégré, avec des prix fictifs ? Le panier de démonstration enregistré sera effacé.", confirmLabel: "Revenir à l’exemple", danger: true })) return;
      setBusy(true); setError("");
      removeDemoBasket().then(reloadDemoSource).catch(reason => setError(reason instanceof Error ? reason.message : "Échec.")).finally(() => setBusy(false));
    }}>Revenir à l’exemple intégré</button>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

/**
 * The demo basket (/v2/panier/demo) and its list (/v2/panier/demo/liste): the basket page on the demo's
 * prices (an administrator's basket, or the app's fictional example), so that anyone can try every
 * setting without an account, a credit or a request.
 */
export default function V2BasketDemoPage({ user, onLogout, listMode = false }: {
  user: V2User | null; onLogout: () => Promise<void>; listMode?: boolean;
}) {
  const source = useDemoSource();
  return <div className="v2-home v2-recipes">
    <a className="v2-skip" href="#v2-basket-main">Aller au contenu</a>
    <V2SiteHeader user={user} onLogout={onLogout} />
    <main id="v2-basket-main" className="v2-wrap v2-recipes-main">
      {source ? <DemoBasket key={source.id} source={source} listMode={listMode} admin={user?.role === "admin"} />
        : <p role="status">Chargement du panier de démonstration…</p>}
    </main>
  </div>;
}

function DemoBasket({ source, listMode, admin }: { source: DemoSource; listMode: boolean; admin: boolean }) {
  const demo = useBasketDemo(source);
  const { items, actions } = demo;
  const display = useBasketView(null, demo);
  const { advanced, mode, filters, setFilters } = display;
  const navigate = useNavigate();
  const activeItems = useMemo(() => items.filter(item => !item.disabled), [items]);
  const { view, comparison, split, savings, lineItems, offStores, storeNames, cityOptions, departmentOptions, hasOpenPrices, filterCount } =
    useBasketComparison(source.snapshot, activeItems, display);
  const [panel, setPanel] = useState<BasketPanel | null>(null);
  const [shown, setShown] = useState({ key: "", count: FIRST_STORES });
  const listKey = JSON.stringify(filters) + (advanced ? "A" : "S") + mode + activeItems.map(basketItemKey).join();
  const shownCount = shown.key === listKey ? shown.count : FIRST_STORES;
  const storeOptions = [...new Set([...storeNames.keys(), ...filters.storeIds])].sort((a, b) => (storeNames.get(a) ?? "").localeCompare(storeNames.get(b) ?? "", "fr"));
  const setStoreActive = (key: string, active: boolean) => display.setStoresOff(withStoreOff(display.storesOff, key, !active));
  const chooseUnit = (item: BasketItem, unit: BaseUnit) =>
    display.setUnits(withUnitChoice(display.units, basketItemKey(item), unit, items.map(basketItemKey)));
  const listPath = shoppingListPath(DEMO_BASKET_PATH);
  // Offline, the demo follows the rule of every basket: read only, ticks apart.
  const readOnly = !useOnline();
  const openList = (view: ListView, anchor?: string) => { if (!readOnly) display.setListView(view); navigate(listPath + (anchor ? "#" + anchor : "")); };
  const togglePanel = (next: BasketPanel) => setPanel(panel === next ? null : next);
  const listView = display.listView;
  const restart = () => { demo.reset(); setPanel(null); };

  // The app's example has no catalogue behind it; a saved basket links to its real products.
  return <BasketReadOnlyContext.Provider value={readOnly ? "offline" : false}><BasketLinksContext.Provider value={!source.fictional}>
    <div className="v2-recipes-heading v2-basket-heading"><div><span className="v2-section-kicker">DÉMONSTRATION</span>
      <h1>{listMode ? "Liste de courses" : "Panier de démonstration"}<span>.</span></h1>
      <p>{listMode ? listView.kind === "all" ? "Les articles du panier, à cocher en rayon." : listView.kind === "stores" ? "Répartie entre les magasins, au meilleur prix." : "Tout le panier dans un magasin ; ce qui n’y a pas de prix vient en premier."
        : source.fictional ? `${source.title}, quatre magasins des environs : essayez tous les réglages du panier.` : `${source.title} : essayez tous les réglages du panier.`}</p></div>
      {!listMode && items.length > 0 && <div className="v2-basket-heading-actions"><Link className="v2-button v2-button-secondary" to={listPath}>Liste de courses</Link></div>}</div>
    <section className="v2-demo-notice" aria-label="À propos de la démonstration">
      <p>{source.fictional ? <><strong>Magasins, produits et prix fictifs.</strong> Tout se calcule sur cet appareil : sans compte ni crédit, et rien n’est envoyé.</>
        : <><strong>Un vrai panier, avec les prix relevés le {day(source.savedAt!)}</strong> : ils ont pu changer depuis. Tout se calcule sur cet appareil, sans compte ni crédit.</>}
        {" "}Vos changements durent le temps de cet onglet.</p>
      <div className="v2-demo-notice-actions">
        {demo.changed && <button type="button" className="v2-button v2-button-secondary" disabled={readOnly} onClick={restart}>Recommencer la démonstration</button>}
        <Link className="v2-button v2-button-primary" to="/v2/produits">Préparer mon panier →</Link>
      </div>
    </section>
    {admin && <DemoAdmin source={source} />}
    {listMode ? <V2ShoppingList view={listView} onView={display.setListView} items={listView.kind === "all" ? activeItems : lineItems}
      comparison={comparison} split={split} storesOff={display.storesOff} advanced={advanced}
      checked={display.checked} onChecked={display.setChecked} basePath={DEMO_BASKET_PATH}
      fetchHint="Incluez au moins un article du panier de démonstration pour le répartir entre les magasins." />
      : items.length ? <>
        <section className="v2-demo-tries" aria-labelledby="v2-demo-tries-heading">
          <h2 id="v2-demo-tries-heading">À essayer</h2>
          <ul>
            <li><button type="button" aria-pressed={advanced} disabled={readOnly} onClick={() => display.setAdvanced(!advanced)}><QuantityIcon />
              <span><b>Quantités</b><small>Une quantité par article : le total couvre des paquets entiers.</small></span></button></li>
            <li><button type="button" aria-pressed={mode === "unit"} disabled={readOnly} onClick={() => display.setMode(mode === "unit" ? "price" : "unit")}><UnitPriceIcon />
              <span><b>Prix à l’unité</b><small>Au kilo, au litre ou à la pièce : les grands formats remontent.</small></span></button></li>
            <li><button type="button" aria-expanded={panel === "filters"} aria-controls="v2-basket-panel-filters" disabled={!comparison || readOnly} onClick={() => togglePanel("filters")}><FilterIcon />
              <span><b>Filtres</b><small>Par magasin, commune ou département, sans rien récupérer.</small></span></button></li>
            <li><Link to={listPath}><ListIcon /><span><b>Liste de courses</b><small>Répartie entre les magasins, ou tout dans un seul.</small></span></Link></li>
          </ul>
          <p>Désactivez ou réactivez un magasin dans la répartition, excluez ou retirez un article : tout se recalcule aussitôt.</p>
        </section>
        <V2BasketToolbar panel={panel} onPanel={setPanel} itemCount={items.length} activeCount={activeItems.length}
          advanced={advanced} onAdvanced={display.setAdvanced} unitMode={mode === "unit"} onUnitMode={value => display.setMode(value ? "unit" : "price")}
          filterCount={filterCount} filtersAvailable={!!comparison} shareable={false}
          action={<span className="v2-demo-badge">{source.fictional ? "Prix fictifs" : `Prix du ${day(source.savedAt!)}`} · sans crédit</span>} />
        {panel === "items" && <V2BasketItems items={items} advanced={advanced} categories={null} categoryError={false} actions={actions} />}
        {panel === "filters" && comparison && !readOnly && <V2BasketFilters filters={filters} onChange={setFilters} storeOptions={storeOptions}
          storeLabel={id => storeNames.get(id) ?? String(id)} cityOptions={cityOptions} departmentOptions={departmentOptions} />}
        {!activeItems.length ? <div className="v2-recipes-card"><p>Incluez au moins un article pour comparer les prix.</p></div>
          : <section className="v2-basket-comparison v2-recipes-card" aria-label="Comparaison des prix">
            <div className="v2-basket-comparison-heading"><div><h2>{comparisonTitle(mode, advanced)}</h2>
              <p>{source.fictional ? "Prix fictifs, relevés ces dernières semaines." : `Prix récupérés le ${fetchedLabel(source.snapshot.fetchedAt)}.`} Déplacement et frais de livraison exclus.</p>
              <button type="button" className="v2-button v2-button-secondary v2-list-entry" onClick={() => openList({ kind: "stores" })}>Liste de courses →</button>
              {advanced && <p>Les paquets communs sont mutualisés dans les totaux. Les choix automatiques sont faits par article : cette sélection n’est pas un minimum global garanti.</p>}</div></div>
            {comparison && split ? <V2BasketResults comparison={comparison} split={split} offStores={offStores} onStoreActive={setStoreActive} items={lineItems}
              advanced={advanced} mode={mode} limited={view.limited.length} shownCount={shownCount} onShowMore={() => setShown({ key: listKey, count: shownCount + MORE_STORES })}
              openPrices={hasOpenPrices} savings={savings} onUnit={chooseUnit} onList={openList} />
              : <p>Aucun prix comparable ne correspond à ce panier et à ces filtres.</p>}
          </section>}
      </> : <div className="v2-recipes-card"><p>Le panier de démonstration est vide.</p>
        <button type="button" className="v2-button v2-button-secondary" disabled={readOnly} onClick={restart}>Recommencer la démonstration</button></div>}
  </BasketLinksContext.Provider></BasketReadOnlyContext.Provider>;
}
