import { useEffect, useMemo, useState } from "react";
import V2SiteHeader from "./V2SiteHeader";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useV2Basket } from "./V2BasketContext";
import V2BasketShare from "./V2BasketShare";
import V2BasketItems from "./V2BasketItems";
import V2BasketFilters from "./V2BasketFilters";
import V2BasketResults from "./V2BasketResults";
import V2BasketToolbar, { type BasketPanel } from "./V2BasketToolbar";
import { useBasketPrices } from "./useBasketPrices";
import { readBasketDefaultStores, writeBasketDefaultStores } from "./v2-basket-default-stores";
import { currentBasketProduct } from "./v2-basket-product";
import { decodeBasketShare, encodeBasketShare, sharedEntryDisabled, sharedEntryName, sharedEntryQuantity } from "./v2-basket-share";
import { basketQuantityLabel } from "./v2-basket-share-labels";
import { productRequest, type Product } from "./v2-products-api";
import { basketItemKey, type BasketItem } from "./v2-basket-storage";
import { buildBasketComparison, emptyBasketFilters, postalDepartment, splitSavings, type BasketFilters } from "./v2-basket-comparison";
import { snapshotView } from "./v2-basket-snapshot";
import { FIRST_STORES, MORE_STORES, fetchedLabel, itemName, type Category } from "./v2-basket-view";
import { creditLabel, nextGrantLabel } from "./v2-basket-credits-api";
import type { V2User } from "./v2-auth-api";
import "./v2-recipes.css";
import "./v2-basket.css";

export default function V2BasketPage({ user, onLogout }: { user: V2User | null; onLogout: () => Promise<void> }) {
  const { items, remove, clear, setEnabled, setQuantity, replace, replaceAll, merge } = useV2Basket();
  const [advanced, setAdvanced] = useState(() => { try { return localStorage.getItem("v2:basket:advanced") === "1"; } catch { return false; } });
  const toggleAdvanced = (value: boolean) => { setAdvanced(value); try { localStorage.setItem("v2:basket:advanced", value ? "1" : "0"); } catch { /* current tab still works */ } };
  const location = useLocation();
  const navigate = useNavigate();
  const sharedLink = location.hash.startsWith("#panier=");
  const sharedEntries = useMemo(() => decodeBasketShare(location.hash), [location.hash]);
  const shareHash = encodeBasketShare(items);
  const shareUrl = shareHash ? window.location.origin + "/v2/panier" + shareHash : null;
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importNotice, setImportNotice] = useState("");
  const closeSharedLink = () => navigate({ pathname: location.pathname, search: location.search }, { replace: true });
  async function importSharedBasket(mode: "add" | "replace") {
    if (!sharedEntries || importing) return;
    if (mode === "replace" && items.length && !window.confirm("Remplacer tout votre panier actuel par ce panier partagé ?")) return;
    setImporting(true);
    setImportError("");
    try {
      const incoming = await Promise.all(sharedEntries.map(async (entry): Promise<BasketItem> => {
        if (entry[0] === "g") return { kind: "group", name: entry[1], disabled: sharedEntryDisabled(entry), quantity: sharedEntryQuantity(entry) };
        if (entry[0] === "s") return { kind: "scope", department: entry[1], family: entry[2], name: entry[3], disabled: sharedEntryDisabled(entry), quantity: sharedEntryQuantity(entry) };
        const product = await currentBasketProduct(entry[1], null, productId => productRequest<Product>("/" + productId));
        if (!product) throw new Error("Produit indisponible");
        return { id: product.id, revision: product.revision, data: product.data, disabled: sharedEntryDisabled(entry), quantity: sharedEntryQuantity(entry) };
      }));
      if (new Set(incoming.map(basketItemKey)).size !== incoming.length) {
        setImportError("Ce lien contient des articles qui désignent maintenant le même produit. Votre panier n’a pas été modifié.");
        return;
      }
      const added = mode === "replace" ? incoming.length : merge(incoming);
      if (mode === "replace") replaceAll(incoming);
      if (incoming.some(item => item.quantity)) toggleAdvanced(true);
      setImportNotice(mode === "replace" ? "Panier remplacé avec les quantités partagées." : added
        ? added + " article" + (added > 1 ? "s" : "") + " ajouté" + (added > 1 ? "s" : "") + " au panier. Les articles déjà présents ont gardé leur quantité."
        : "Tous ces articles sont déjà dans votre panier ; leurs quantités n’ont pas changé.");
      closeSharedLink();
    } catch {
      setImportError("Impossible de récupérer tous les produits de ce panier. Aucun article n’a été ajouté.");
    } finally { setImporting(false); }
  }

  const userId = user?.id ?? null;
  const { snapshot, credits, state, fetchPrices } = useBasketPrices(userId, items);
  const [panel, setPanel] = useState<BasketPanel | null>(null);
  const [defaultStores, setDefaultStores] = useState(readBasketDefaultStores);
  const [filters, setFilters] = useState<BasketFilters>(() => ({
    ...emptyBasketFilters, storeIds: readBasketDefaultStores().map(store => store.id),
  }));
  const [defaultStoreError, setDefaultStoreError] = useState(false);
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [categoryError, setCategoryError] = useState(false);
  const [shown, setShown] = useState({ key: "", count: FIRST_STORES });
  const activeItems = useMemo(() => items.filter(item => !item.disabled), [items]);
  const hasComparable = items.some(item => "kind" in item);

  // The other comparison choices of a group are only read when the articles are being edited.
  useEffect(() => {
    if (!hasComparable || panel !== "items") return;
    const controller = new AbortController();
    fetch("/api/v2/catalogue/categories", { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error("Catalogue indisponible"); return response.json() as Promise<Category[]>; })
      .then(value => { if (!controller.signal.aborted) { setCategories(value); setCategoryError(false); } })
      .catch(() => { if (!controller.signal.aborted) setCategoryError(true); });
    return () => controller.abort();
  }, [hasComparable, panel]);

  const view = useMemo(() => snapshotView(snapshot, activeItems), [snapshot, activeItems]);
  const comparison = useMemo(() => view.lines.length
    ? buildBasketComparison(view.lines, view.responses, filters, advanced) : null, [view, filters, advanced]);
  const savings = useMemo(() => comparison ? splitSavings(view.lines, view.responses, filters, advanced, comparison) : new Map(),
    [comparison, view, filters, advanced]);
  const lineItems = view.lines.map(line => line.item);
  const availableRows = [...view.responses.values()].flatMap(response => response?.latest_by_store ?? []);
  const storeNames = new Map<number, string>();
  for (const row of availableRows) storeNames.set(row.store_id, [row.retailer, row.store_name, row.city].filter(Boolean).join(" · "));
  for (const store of defaultStores) if (!storeNames.has(store.id)) storeNames.set(store.id, store.name);
  const storeOptions = [...new Set([...storeNames.keys(), ...filters.storeIds])]
    .sort((a, b) => (storeNames.get(a) ?? "").localeCompare(storeNames.get(b) ?? "", "fr"));
  const cityOptions = [...new Set(availableRows.map(row => row.city?.trim()).filter((value): value is string => !!value))].sort((a, b) => a.localeCompare(b, "fr"));
  const departmentOptions = [...new Set(availableRows.map(row => postalDepartment(row.postal_code)).filter((value): value is string => !!value))].sort((a, b) => a.localeCompare(b, "fr"));
  const hasOpenPrices = comparison?.stores.some(store => store.choices.some(choice => choice.reading.source_provider === "open_prices")) ?? false;
  const filterCount = filters.storeIds.length + filters.cities.length + filters.departments.length;
  const defaultsMatch = filters.storeIds.length === defaultStores.length
    && filters.storeIds.every(id => defaultStores.some(store => store.id === id));
  const defaults = {
    count: defaultStores.length, matches: defaultsMatch, error: defaultStoreError,
    unavailable: defaultStores.filter(store => filters.storeIds.includes(store.id) && !availableRows.some(row => row.store_id === store.id))
      .map(store => storeNames.get(store.id) ?? store.name),
    save() {
      try {
        const stores = filters.storeIds.map(id => ({ id, name: (storeNames.get(id) ?? `Magasin ${id}`).slice(0, 160) }));
        writeBasketDefaultStores(stores); setDefaultStores(stores); setDefaultStoreError(false);
      } catch { setDefaultStoreError(true); }
    },
    restore() { setFilters({ ...filters, storeIds: defaultStores.map(store => store.id) }); },
    remove() {
      try { writeBasketDefaultStores([]); setDefaultStores([]); setDefaultStoreError(false); } catch { setDefaultStoreError(true); }
    },
  };
  const listKey = (snapshot?.fetchedAt ?? "") + JSON.stringify(filters) + (advanced ? "A" : "S") + activeItems.map(basketItemKey).join();
  const shownCount = shown.key === listKey ? shown.count : FIRST_STORES;
  const fetching = state.phase === "loading";
  const noCredit = credits !== null && credits.balance < 1;

  return <div className="v2-home v2-recipes">
    <a className="v2-skip" href="#v2-basket-main">Aller au contenu</a>
    <V2SiteHeader user={user} onLogout={onLogout} />
    <main id="v2-basket-main" className="v2-wrap v2-recipes-main">
      <div className="v2-recipes-heading v2-basket-heading"><div><span className="v2-section-kicker">VOS COURSES</span><h1>Mon panier<span>.</span></h1><p>Comparez les prix de vos courses.</p></div><Link className="v2-button v2-button-secondary" to="/v2/produits">Ajouter un article →</Link></div>
      {sharedLink && <section className="v2-shared-basket" aria-label="Panier partagé">
        {sharedEntries ? <>
          <h2>Panier partagé</h2>
          <p>{sharedEntries.length} article{sharedEntries.length > 1 ? "s" : ""} dans ce lien. Les prix seront recalculés selon les magasins disponibles.</p>
          <ul>{sharedEntries.map((entry, index) => <li key={index}>{sharedEntryName(entry)} <span>· {basketQuantityLabel(sharedEntryQuantity(entry))}{sharedEntryDisabled(entry) ? " · exclu du calcul" : ""}</span></li>)}</ul>
          <p>Ajouter conserve les articles et quantités déjà présents. Remplacer reprend exactement ce panier partagé.</p>
          <div className="v2-shared-basket-actions"><button type="button" className="v2-button v2-button-primary" disabled={importing} onClick={() => void importSharedBasket("add")}>{importing ? "Importation…" : "Ajouter les articles manquants"}</button>
            <button type="button" className="v2-button v2-button-secondary" disabled={importing} onClick={() => void importSharedBasket("replace")}>Remplacer mon panier</button>
            <button type="button" className="v2-button v2-button-secondary" onClick={closeSharedLink}>Ignorer</button></div>
          {importError && <p role="alert">{importError}</p>}
        </> : <><h2>Lien de panier invalide</h2><p>Ce lien ne peut pas être ouvert.</p><button type="button" className="v2-button v2-button-secondary" onClick={closeSharedLink}>Fermer</button></>}
      </section>}
      {importNotice && <p role="status">{importNotice}</p>}
      {items.length ? <>
        <V2BasketToolbar panel={panel} onPanel={setPanel} itemCount={items.length} activeCount={activeItems.length}
          advanced={advanced} onAdvanced={toggleAdvanced} filterCount={filterCount} filtersAvailable={!!comparison}
          signedIn={!!user} credits={credits} hasPrices={!!snapshot} fetching={fetching} onFetch={() => void fetchPrices()} />
        <div className="v2-basket-status">
          {fetching && <p role="status">Récupération des prix…</p>}
          {state.phase === "done" && <p role="status">{state.message}</p>}
          {state.phase === "error" && <p role="alert" className="v2-recipes-error">{state.message}{state.signedOut && <> <Link to="/v2/connexion?next=panier">Se connecter</Link></>}</p>}
          {state.phase !== "error" && noCredit && credits && <p role="status">Plus de crédit pour le moment. Le prochain arrive {nextGrantLabel(credits.next_grant_on)}.</p>}
        </div>
        {panel === "share" && <div className="v2-basket-panel" id="v2-basket-panel-share"><V2BasketShare items={items} url={shareUrl} /></div>}
        {panel === "items" && <V2BasketItems items={items} advanced={advanced} categories={categories} categoryError={categoryError}
          actions={{ setEnabled, setQuantity, replace, remove, clear }} />}
        {panel === "filters" && comparison && <V2BasketFilters filters={filters} onChange={setFilters} storeOptions={storeOptions}
          storeLabel={id => storeNames.get(id) ?? String(id)} cityOptions={cityOptions} departmentOptions={departmentOptions} defaults={defaults} />}
        {!activeItems.length ? <div className="v2-recipes-card"><p>Activez au moins un article pour comparer les prix.</p></div>
          : !user ? <section className="v2-basket-comparison v2-recipes-card" aria-label="Comparaison des prix">
            <h2>Comparer les prix</h2>
            <p>Connectez-vous pour récupérer les prix de ce panier. Chaque compte reçoit 5 crédits par jour, 20 par semaine au maximum : récupérer les prix en coûte 1.</p>
            <Link className="v2-button v2-button-primary" to="/v2/connexion?next=panier">Se connecter</Link>
          </section>
            : <section className="v2-basket-comparison v2-recipes-card" aria-label="Comparaison des prix">
              {!snapshot ? <>
                <h2>Comparer les prix</h2>
                <p>Les prix sont récupérés à la demande, pour 1 crédit{credits ? ` (${creditLabel(credits.balance)} restant${credits.balance > 1 ? "s" : ""})` : ""}. Ensuite, filtrer les magasins, exclure un article ou passer au panier avancé ne coûte rien.</p>
              </> : <>
                <div className="v2-basket-comparison-heading"><div><h2>{advanced ? "Estimation des achats" : "Meilleur prix"}</h2>
                  <p>Prix récupérés le {fetchedLabel(snapshot.fetchedAt)}. Déplacement et frais de livraison exclus.</p>{advanced && <p>Les paquets communs sont mutualisés dans les totaux. Les choix automatiques sont faits par article : cette sélection n’est pas un minimum global garanti.</p>}</div></div>
                {view.stale.length > 0 && <p className="v2-basket-stale" role="status">Non inclus dans ce relevé : {view.stale.map(itemName).join(", ")}. Actualisez les prix pour les comparer (1 crédit).</p>}
                {comparison && <V2BasketResults comparison={comparison} items={lineItems} advanced={advanced} limited={view.limited.length}
                  shownCount={shownCount} onShowMore={() => setShown({ key: listKey, count: shownCount + MORE_STORES })} openPrices={hasOpenPrices} savings={savings} />}
              </>}
            </section>}
      </> : <div className="v2-recipes-card"><p>Votre panier est vide pour le moment. Ajoutez un produit, un groupe comparable ou un ensemble depuis le catalogue.</p></div>}
    </main>
  </div>;
}
