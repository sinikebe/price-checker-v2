import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "./useConfirm";
import { V2PageFrame } from "./V2SiteHeader";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useV2Basket } from "./V2BasketContext";
import { useBasketView } from "./useBasketView";
import V2BasketShare from "./V2BasketShare";
import V2DemoBasketSave from "./V2DemoBasketSave";
import { SharedBanner, SharedInvite, SharedJoin, SharedStart } from "./V2SharedBasket";
import { SHARED_BASKET_PATH, inviteFromHash, takePendingInvite } from "./v2-shared-basket";
import V2BasketItems from "./V2BasketItems";
import V2BasketTextAdd from "./V2BasketTextAdd";
import V2SharedBasketView from "./V2SharedBasketView";
import V2ShoppingList from "./V2ShoppingList";
import { listSetting, shoppingListPath, type ListView } from "./v2-shopping-list";
import V2BasketFilters from "./V2BasketFilters";
import { useSiteFilter } from "./useSiteFilter";
import { useStoreDirectoryLabels } from "./useStoreDirectoryLabels";
import V2BasketResults from "./V2BasketResults";
import V2BasketToolbar, { V2BasketFetch, type BasketPanel } from "./V2BasketToolbar";
import { basketFetchCost, useBasketPrices } from "./useBasketPrices";
import { useExtensionRefresh } from "./useExtensionRefresh";
import { readBasketDefaultStores, writeBasketDefaultStores } from "./v2-basket-default-stores";
import { currentBasketProduct } from "./v2-basket-product";
import { decodeBasketShare, encodeBasketShare, sharedEntryDisabled, sharedEntryName, sharedEntryQuantity } from "./v2-basket-share";
import { basketQuantityLabel } from "./v2-basket-share-labels";
import { productRequest, type Product } from "./v2-products-api";
import { basketItemKey, isFreeText, isPriceable, type BasketItem } from "./v2-basket-storage";
import { useBasketComparison } from "./useBasketComparison";
import { useOnline } from "./useOnline";
import { BasketReadOnlyContext, OFFLINE_TITLE } from "./v2-basket-read-only";
import { withStoreOff } from "./v2-basket-store-off";
import type { BaseUnit } from "./v2-basket-quantity";
import { withUnitChoice } from "./v2-measures";
import { FIRST_STORES, MORE_STORES, comparisonTitle, fetchedLabel, itemName, type Category } from "./v2-basket-view";
import { balanceText, costNote, creditLabel, outOfCredits, shortText } from "./v2-basket-credits-api";
import type { V2User } from "./v2-auth-api";
import "./v2-recipes.css";
import "./v2-basket.css";

const NO_ITEMS: BasketItem[] = [];

/** The personal basket (/v2/panier, on this device) or the shared one (/v2/panier/partage, live for every member). */
export default function V2BasketPage({ user, onLogout, sharedMode = false, listMode = false }: {
  user: V2User | null; onLogout: () => Promise<void>; sharedMode?: boolean;
  /** The shopping list of this basket (/liste), built from the prices already fetched. */
  listMode?: boolean;
}) {
  const context = useV2Basket();
  const confirm = useConfirm();
  const { shared } = context;
  const basket = sharedMode ? context.sharedBasket : context;
  const sharing = sharedMode && basket !== null;
  const { remove, clear, setEnabled, setQuantity, replace, replaceAll, merge } = basket ?? context;
  const items = basket?.items ?? NO_ITEMS;
  // Quantities, price or unit price, units, stores off and filters: in this browser for the personal
  // basket, on the server (the same for every member) for the shared one.
  const display = useBasketView(user?.id ?? null, sharing ? shared : null);
  // Offline, the basket and its list are read only, ticks apart.
  const readOnly = !useOnline();
  const { advanced, mode, filters, setFilters } = display;
  const siteFilter = useSiteFilter().filter;
  const toggleAdvanced = display.setAdvanced;
  const changeMode = display.setMode;
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
  const invite = inviteFromHash(location.hash);
  const signedInId = user?.id;
  // Invitations open on the shared basket page, also the first links that pointed at /v2/panier. One
  // opened while signed out comes back after signing in.
  useEffect(() => {
    if (!sharedMode && invite) { navigate({ pathname: SHARED_BASKET_PATH, hash: location.hash }, { replace: true }); return; }
    if (!signedInId || location.hash) return;
    const pending = takePendingInvite();
    if (pending) navigate({ pathname: SHARED_BASKET_PATH, hash: "#rejoindre=" + pending }, { replace: true });
  }, [sharedMode, invite, signedInId, location.hash, navigate]);
  async function importSharedBasket(mode: "add" | "replace") {
    if (!sharedEntries || importing) return;
    if (mode === "replace" && items.length && !await confirm({ title: "Remplacer le panier", message: "Remplacer tout votre panier actuel par ce panier partagé ?", confirmLabel: "Remplacer", danger: true })) return;
    setImporting(true);
    setImportError("");
    try {
      const incoming = await Promise.all(sharedEntries.map(async (entry): Promise<BasketItem> => {
        if (entry[0] === "g" || entry[0] === "t") return { kind: entry[0] === "g" ? "group" : "text", name: entry[1], disabled: sharedEntryDisabled(entry), quantity: sharedEntryQuantity(entry) };
        if (entry[0] === "s") return { kind: "scope", department: entry[1], family: entry[2], name: entry[3], disabled: sharedEntryDisabled(entry), quantity: sharedEntryQuantity(entry) };
        if (entry[0] === "x") return { kind: "selection", name: entry[1], ...entry[3], disabled: sharedEntryDisabled(entry), quantity: sharedEntryQuantity(entry) };
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
  const refetch = useRef<(quiet?: boolean) => Promise<void>>(async () => undefined);
  const extension = useExtensionRefresh(user);
  const startExtension = extension.start;
  const afterFetch = useCallback((ids: number[]) => { void startExtension(ids, () => { void refetch.current(true); }); }, [startExtension]);
  // A shared basket's prices are the basket's: fetched by one member, seen by all.
  const sharedPrices = useMemo(() => sharing && shared.sharedId ? { basketId: shared.sharedId, pricesAt: shared.basket?.prices?.fetched_at ?? null, lines: shared.lines } : undefined,
    [sharing, shared.sharedId, shared.basket?.prices?.fetched_at, shared.lines]);
  const { snapshot, credits, state, fetchPrices, fetchedBy } = useBasketPrices(userId, items, afterFetch, sharedPrices);
  refetch.current = fetchPrices;
  const [panel, setPanel] = useState<BasketPanel | null>(null);
  const [defaultStores, setDefaultStores] = useState(readBasketDefaultStores);
  const [defaultStoreError, setDefaultStoreError] = useState(false);
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [categoryError, setCategoryError] = useState(false);
  const [shown, setShown] = useState({ key: "", count: FIRST_STORES });
  const activeItems = useMemo(() => items.filter(item => !item.disabled), [items]);
  // Free text has no price: it stays out of the comparison, and goes to the list as an article to find.
  const priceItems = useMemo(() => activeItems.filter(isPriceable), [activeItems]);
  const activeTexts = useMemo(() => activeItems.filter(isFreeText), [activeItems]);
  /** Add free text to this basket; the reason when it cannot be added. */
  const addText = (name: string): string | null => {
    const target = sharedMode ? context.sharedBasket : context;
    if (!target) return "Aucun panier partagé ouvert.";
    const item: BasketItem = { kind: "text", name };
    if (target.has(item)) return `« ${name} » est déjà dans le panier.`;
    target.add(item);
    return null;
  };
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

  // Stores switched off in the split by hand stay in the filters and in the store ranking.
  const { view, comparison, split, savings, lineItems, availableRows, offStores, storeNames, cityOptions, departmentOptions, hasOpenPrices, filterCount } =
    useBasketComparison(snapshot, priceItems, display);
  const setStoreActive = (key: string, active: boolean) => display.setStoresOff(withStoreOff(display.storesOff, key, !active));
  const chooseUnit = (item: BasketItem, unit: BaseUnit) =>
    display.setUnits(withUnitChoice(display.units, basketItemKey(item), unit, items.map(basketItemKey)));
  for (const store of defaultStores) if (!storeNames.has(store.id)) storeNames.set(store.id, store.name);
  // A shared filter can name stores without a price in this basket (another member's account filter):
  // their names come from this account's filter, or else from the store directory, read only then.
  const siteLabels = new Map(siteFilter.stores.map(store => [store.id, store.label]));
  const directoryLabels = useStoreDirectoryLabels(sharing && panel === "filters"
    && filters.storeIds.some(id => !storeNames.has(id) && !siteLabels.has(id)));
  const storeLabel = (id: number) => storeNames.get(id) ?? siteLabels.get(id) ?? directoryLabels?.get(id) ?? `Magasin ${id}`;
  const storeOptions = [...new Set([...storeNames.keys(), ...filters.storeIds])]
    .sort((a, b) => storeLabel(a).localeCompare(storeLabel(b), "fr"));
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
  const listKey = (snapshot?.fetchedAt ?? "") + JSON.stringify(filters) + (advanced ? "A" : "S") + mode + activeItems.map(basketItemKey).join();
  const shownCount = shown.key === listKey ? shown.count : FIRST_STORES;
  const fetching = state.phase === "loading";
  const fetchCost = basketFetchCost(items);
  const noCredit = outOfCredits(credits, fetchCost);

  const basePath = sharedMode ? SHARED_BASKET_PATH : "/v2/panier";
  /** Open the list in this mode (for a shared basket, the mode every member sees); offline, in the mode it already has. */
  const openList = (mode: ListView, anchor?: string) => { if (!readOnly) display.setListView(mode); navigate(shoppingListPath(basePath) + (anchor ? "#" + anchor : "")); };
  if (listMode) {
    const listView = display.listView;
    return <BasketReadOnlyContext.Provider value={readOnly ? "offline" : false}><V2PageFrame section="basket" user={user} onLogout={onLogout}>
        <div className="v2-recipes-heading v2-basket-heading"><div><span className="v2-section-kicker">{sharedMode ? "PANIER PARTAGÉ" : "VOS COURSES"}</span><h1>Liste de courses<span>.</span></h1>
          <p>{listView.kind === "all" ? "Les articles du panier, à cocher en rayon." : listView.kind === "stores" ? "Répartie entre les magasins, au meilleur prix." : "Tout le panier dans un magasin ; ce qui n’y a pas de prix vient en premier."}</p></div></div>
        {sharedMode && !basket ? <div className="v2-recipes-card"><p>Aucun panier partagé ouvert. <Link to={SHARED_BASKET_PATH}>Ouvrir ou créer un panier partagé</Link>.</p></div> : <>
          {sharing && <SharedBanner shared={shared} user={user} onInvite={() => navigate(basePath)} />}
          {listView.kind !== "all" && snapshot && view.stale.length > 0 && <p className="v2-basket-stale" role="status">Pas encore dans le relevé de prix : {view.stale.map(itemName).join(", ")}. <Link to={basePath}>Actualisez les prix</Link> pour les placer dans un magasin.</p>}
          <V2ShoppingList view={listView} onView={display.setListView} items={listView.kind === "all" ? activeItems : [...view.lines.map(line => line.item), ...activeTexts]} onAddText={readOnly || (sharedMode && !basket) ? undefined : addText}
            comparison={snapshot ? comparison : null} split={snapshot ? split : null} storesOff={display.storesOff} advanced={advanced}
            checked={display.checked} onChecked={display.setChecked} basePath={basePath} sharedName={sharing ? shared.basket?.name : undefined}
            addedBy={sharing ? shared.addedBy : undefined}
            fetchHint="La répartition entre magasins et la liste d’un magasin se construisent avec les prix récupérés pour ce panier." />
        </>}
    </V2PageFrame></BasketReadOnlyContext.Provider>;
  }
  // A shared basket created from the personal one starts with its settings too.
  const personalSettings = { advanced: display.advanced, compare: display.mode, filters: display.filters, stores_off: display.storesOff, units: display.units };

  return <BasketReadOnlyContext.Provider value={readOnly ? "offline" : false}><V2PageFrame section="basket" user={user} onLogout={onLogout}>
      <div className="v2-recipes-heading v2-basket-heading"><div><span className="v2-section-kicker">VOS COURSES</span><h1>{sharedMode ? "Panier partagé" : "Mon panier"}<span>.</span></h1><p>{sharing ? "Modifié en direct par ses membres, avec les mêmes réglages pour tous." : sharedMode ? "Un panier que plusieurs comptes remplissent ensemble, en direct." : "Comparez les prix de vos courses."}</p></div><div className="v2-basket-heading-actions">{basket && items.length > 0 && <Link className="v2-button v2-button-secondary" to={shoppingListPath(basePath)}>Liste de courses</Link>}
        {!(invite && !user) && <Link className="v2-button v2-button-secondary" to="/v2/produits">Ajouter un article →</Link>}</div></div>
      {readOnly && !sharing && <p className="v2-basket-offline-note" role="status">Hors connexion : le panier est en lecture seule et sa liste de courses se coche toujours. Le reste se modifie au retour de la connexion.</p>}
      {sharedLink && <section className="v2-shared-basket" aria-label="Panier partagé">
        {sharedEntries ? <>
          <h2>Panier partagé</h2>
          <p>{sharedEntries.length} article{sharedEntries.length > 1 ? "s" : ""} dans ce lien. Les prix seront recalculés selon les magasins disponibles.</p>
          <ul>{sharedEntries.map((entry, index) => <li key={index}>{sharedEntryName(entry)} <span>· {basketQuantityLabel(sharedEntryQuantity(entry))}{sharedEntryDisabled(entry) ? " · exclu du calcul" : ""}</span></li>)}</ul>
          <p>Ajouter conserve les articles et quantités déjà présents. Remplacer reprend exactement ce panier partagé.</p>
          <div className="v2-shared-basket-actions"><button type="button" className="v2-button v2-button-primary" disabled={importing || readOnly} title={readOnly ? OFFLINE_TITLE : undefined} onClick={() => void importSharedBasket("add")}>{importing ? "Importation…" : "Ajouter les articles manquants"}</button>
            <button type="button" className="v2-button v2-button-secondary" disabled={importing || readOnly} title={readOnly ? OFFLINE_TITLE : undefined} onClick={() => void importSharedBasket("replace")}>Remplacer mon panier</button>
            <button type="button" className="v2-button v2-button-secondary" onClick={closeSharedLink}>Ignorer</button></div>
          {importError && <p role="alert">{importError}</p>}
        </> : <><h2>Lien de panier invalide</h2><p>Ce lien ne peut pas être ouvert.</p><button type="button" className="v2-button v2-button-secondary" onClick={closeSharedLink}>Fermer</button></>}
      </section>}
      {importNotice && <p role="status">{importNotice}</p>}
      {invite && (user ? <SharedJoin invite={invite} user={user} shared={shared} onClose={closeSharedLink} /> : <V2SharedBasketView invite={invite} />)}
      {shared.notice && <p role="status" className="v2-shared-notice">{shared.notice} <button type="button" className="v2-basket-remove" onClick={shared.clearNotice}>Fermer</button></p>}
      {sharedMode && !basket ? !invite && <div className="v2-recipes-card"><SharedStart shared={shared} user={user} items={context.items} startSettings={personalSettings} copyByDefault={false} /></div> : <>
      {sharing && <SharedBanner shared={shared} user={user} onInvite={() => setPanel("share")} />}
      {sharing && !items.length && panel === "share" && <div className="v2-basket-panel" id="v2-basket-panel-share"><SharedInvite shared={shared} user={user} /></div>}
      {items.length ? <>
        <V2BasketToolbar panel={panel} onPanel={setPanel} itemCount={items.length} activeCount={activeItems.length}
          advanced={advanced} onAdvanced={toggleAdvanced} unitMode={mode === "unit"} onUnitMode={value => changeMode(value ? "unit" : "price")} filterCount={filterCount} filtersAvailable={!!comparison}
          action={<V2BasketFetch signedIn={!!user} credits={credits} cost={fetchCost} hasPrices={!!snapshot} fetching={fetching} onFetch={() => void fetchPrices()} />} />
        <div className="v2-basket-status">
          {fetching && <p role="status">Récupération des prix…</p>}
          {extension.state.phase === "reading" && <p role="status" className="v2-basket-extension">Extension : lecture des prix {extension.state.store}… {extension.state.done}/{extension.state.total}
            {extension.state.needsHuman && " — Carrefour demande une vérification : terminez-la dans l’onglet carrefour.fr qui vient de passer au premier plan, la lecture reprendra seule."}</p>}
          {(extension.state.phase === "done" || extension.state.phase === "stopped") && <p role={extension.state.phase === "stopped" ? "alert" : "status"}>{extension.state.message}</p>}
          {state.phase === "done" && <p role="status">{state.message}</p>}
          {state.phase === "error" && <p role="alert" className="v2-recipes-error">{state.message}{state.signedOut && <> <Link to="/v2/connexion?next=panier">Se connecter</Link></>}</p>}
          {state.phase !== "error" && noCredit && credits && fetchCost > 0 && <p role="status">{shortText(credits, fetchCost)}</p>}
        </div>
        {panel === "share" && !readOnly && <div className="v2-basket-panel" id="v2-basket-panel-share">
          {sharing ? <SharedInvite shared={shared} user={user} /> : <SharedStart shared={shared} user={user} items={items} startSettings={personalSettings} copyByDefault />}
          <h3 className="v2-shared-copy-title">Envoyer une copie</h3>
          <p className="v2-shared-hint">Une copie figée du panier, sans compte et sans rien enregistrer sur le serveur.</p>
          <V2BasketShare items={items} url={shareUrl} />
          {user?.role === "admin" && <V2DemoBasketSave items={items} settings={{ ...personalSettings, list_mode: listSetting(display.listView) }} />}</div>}
        {panel === "items" && <V2BasketItems items={items} advanced={advanced} categories={categories} categoryError={categoryError}
          actions={{ setEnabled, setQuantity, replace, remove, clear }} onAddText={addText}
          addedBy={sharing ? shared.addedBy : undefined} sharedName={shared.basket?.name} />}
        {panel === "filters" && comparison && !readOnly && <V2BasketFilters filters={filters} onChange={setFilters} storeOptions={storeOptions}
          storeLabel={storeLabel} cityOptions={cityOptions} departmentOptions={departmentOptions} defaults={defaults} shared={sharing} />}
        {!priceItems.length ? <div className="v2-recipes-card"><p>{activeItems.length
          ? "Les textes libres n’ont pas de prix : remplacez-les par un produit, un groupe ou un ensemble (Articles) pour comparer les prix."
          : "Activez au moins un article pour comparer les prix."}</p></div>
          : !user ? <section className="v2-basket-comparison v2-recipes-card" aria-label="Comparaison des prix">
            <h2>Comparer les prix</h2>
            <p>Connectez-vous pour récupérer les prix de ce panier. Chaque compte reçoit des crédits chaque jour : récupérer les prix coûte 1 crédit par article inclus.</p>
            <Link className="v2-button v2-button-primary" to="/v2/connexion?next=panier">Se connecter</Link>
          </section>
            : <section className="v2-basket-comparison v2-recipes-card" aria-label="Comparaison des prix">
              {!snapshot ? <>
                <h2>Comparer les prix</h2>
                <p>Les prix sont récupérés à la demande, {credits?.unlimited ? "sans limite pour votre compte administrateur" : <>pour 1 crédit par article inclus, soit {creditLabel(fetchCost)} pour ce panier{credits ? ` (${balanceText(credits)})` : ""}</>}. Ensuite, filtrer les magasins, exclure un article ou passer au panier avancé ne coûte rien.</p>
              </> : <>
                <div className="v2-basket-comparison-heading"><div><h2>{comparisonTitle(mode, advanced)}</h2>
                  <p>Prix récupérés le {fetchedLabel(snapshot.fetchedAt)}{sharing ? fetchedBy ? ` par ${fetchedBy}, pour tous les membres` : ", pour tous les membres" : ""}. Déplacement et frais de livraison exclus.</p>
                  <button type="button" className="v2-button v2-button-secondary v2-list-entry" onClick={() => openList({ kind: "stores" })}>Liste de courses →</button>{advanced && <p>Les paquets communs sont mutualisés dans les totaux. Les choix automatiques sont faits par article : cette sélection n’est pas un minimum global garanti.</p>}</div></div>
                {view.stale.length > 0 && <p className="v2-basket-stale" role="status">Non inclus dans ce relevé : {view.stale.map(itemName).join(", ")}. Actualisez les prix pour les comparer{costNote(credits, fetchCost)}.</p>}
                {comparison && split && <V2BasketResults comparison={comparison} split={split} offStores={offStores} onStoreActive={setStoreActive} items={lineItems} advanced={advanced} mode={mode} limited={view.limited.length}
                  shownCount={shownCount} onShowMore={() => setShown({ key: listKey, count: shownCount + MORE_STORES })} openPrices={hasOpenPrices} savings={savings} onUnit={chooseUnit}
                  onList={openList} />}
              </>}
            </section>}
      </> : sharing ? <div className="v2-recipes-card"><p>Ce panier partagé est vide pour le moment. Ajoutez un produit, un groupe comparable ou un ensemble depuis le catalogue, ou un texte libre : ses membres le verront aussitôt.</p>
          {!readOnly && <V2BasketTextAdd onAdd={addText} />}</div>
        : <><div className="v2-recipes-card"><p>Votre panier est vide pour le moment. Ajoutez un produit, un groupe comparable ou un ensemble depuis le catalogue, ou un texte libre pour ce qui n’y est pas encore.</p>
          {!readOnly && <V2BasketTextAdd onAdd={addText} />}</div>
          {!invite && !shared.sharedId && <div className="v2-recipes-card v2-shared-empty-start"><SharedStart shared={shared} user={user} items={items} startSettings={personalSettings} copyByDefault={false} /></div>}</>}
      </>}
  </V2PageFrame></BasketReadOnlyContext.Provider>;
}
