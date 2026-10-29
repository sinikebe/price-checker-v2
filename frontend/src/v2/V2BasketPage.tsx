import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useV2Basket } from "./V2BasketContext";
import V2ShareButton from "./V2ShareButton";
import { decodeBasketShare, encodeBasketShare, sharedEntryDisabled, sharedEntryName, sharedEntryQuantity } from "./v2-basket-share";
import { productRequest, type Product } from "./v2-products-api";
import { basketItemKey, validBasketQuantity, type BasketGroup, type BasketItem, type BasketProduct, type BasketQuantity, type BasketScope } from "./v2-basket-storage";
import { buildBasketComparison, emptyBasketFilters, postalDepartment,
  pricePosition, type BasketFilters, type BasketLine, type BasketPrice, type BasketPriceResponse, type PriceChoice } from "./v2-basket-comparison";
import type { V2User } from "./v2-auth-api";
import "./v2-recipes.css";
import "./v2-basket.css";

type PriceSnapshot = { key: string; lines: BasketLine[]; responses: Map<number, BasketPriceResponse | null> };
type Category = { name: string; department: string; family: string; comparison_scope: string | null };
const PAGE_SIZE = 5;
const channelNames: Record<BasketPrice["sales_channel"], string> = {
  in_store: "En magasin", drive: "Drive", delivery: "Livraison",
};
const money = (cents: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(cents / 100);
const productName = (product: BasketProduct) => [product.data.brand, product.data.name].filter(Boolean).join(" ");
const itemName = (item: BasketItem) => "kind" in item ? item.name : productName(item);
const itemKind = (item: BasketItem) => "kind" in item ? item.kind === "group" ? "Groupe comparable" : "Ensemble" : "Produit";
const fold = (value: string) => value.toLocaleLowerCase("fr");
function itemHref(item: BasketItem) {
  if (!("kind" in item)) return "/v2/produits/" + item.id;
  if (item.kind === "group") return "/v2/categories/" + encodeURIComponent(item.name);
  return "/v2/produits?" + new URLSearchParams({ rayon: item.department, famille: item.family, ensemble: item.name });
}
function alternatives(item: BasketItem, categories: Category[]): (BasketGroup | BasketScope)[] {
  if (!("kind" in item)) return [];
  const group = item.kind === "group" ? categories.find(category => fold(category.name) === fold(item.name)) : null;
  if (item.kind === "group" && !group?.comparison_scope) return [];
  const location = item.kind === "scope" ? item : group!;
  const scope = item.kind === "scope" ? item.name : group!.comparison_scope!;
  const members = categories.filter(category => fold(category.department) === fold(location!.department)
    && fold(category.family) === fold(location!.family)
    && fold(category.comparison_scope ?? "") === fold(scope));
  if (!members.length) return [];
  const choices: (BasketGroup | BasketScope)[] = [
    { kind: "scope", name: scope, department: location!.department, family: location!.family },
    ...members.map(category => ({ kind: "group" as const, name: category.name })),
  ];
  return choices;
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
function DatedPrice({ choice, range }: { choice: PriceChoice; range: { min: number; max: number } }) {
  const age = freshness(choice.reading.observed_at);
  const position = pricePosition(choice.cents, range.min, range.max);
  const positionLabel = { low: "prix bas", middle: "prix intermédiaire", high: "prix haut", neutral: "prix identique ou seul" }[position];
  return <span className="v2-basket-reading" data-price-position={position}>
    <strong title={positionLabel} aria-label={money(choice.cents) + " · " + positionLabel}>{money(choice.cents)}</strong>
    {choice.packages > 1 && <small>{choice.packages} paquets à acheter</small>}
    {choice.used && <small>Part utilisée : {money(choice.usedCents)}</small>}
    <span className="v2-basket-age" data-age={age.code} title={age.label}><span className="v2-basket-visually-hidden">Fraîcheur : {age.label}</span></span>
    <small>Relevé du {date(choice.reading.observed_at)}</small>
  </span>;
}
function QuantityEditor({ item, onChange }: { item: BasketItem; onChange: (value: BasketQuantity) => void }) {
  const initial = item.quantity ?? { amount: "1", unit: "package" as const };
  const [amount, setAmount] = useState(initial.amount);
  const [unit, setUnit] = useState<BasketQuantity["unit"]>(initial.unit);
  const [error, setError] = useState(false);
  function save(nextAmount: string, nextUnit: BasketQuantity["unit"]) {
    const value = { amount: nextAmount, unit: nextUnit };
    if (!validBasketQuantity(value)) { setError(true); return; }
    setError(false); onChange(value);
  }
  return <div className="v2-basket-quantity"><label>Quantité demandée<input aria-label={`Quantité demandée pour ${itemName(item)}`} type="number" min="0.000001" max="999999" step="any" value={amount} onChange={event => { setAmount(event.target.value); setError(false); }} /></label>
    <label>Unité<select aria-label={`Unité pour ${itemName(item)}`} value={unit} onChange={event => setUnit(event.target.value as BasketQuantity["unit"])}>
      <option value="package">paquet(s)</option><option value="g">g</option><option value="kg">kg</option><option value="ml">ml</option><option value="cl">cl</option><option value="l">l</option><option value="piece">pièce(s)</option>
    </select></label><button type="button" className="v2-button v2-button-secondary" onClick={() => save(amount, unit)}>Appliquer</button>
    {error && <small role="alert">Quantité positive requise (6 décimales maximum).</small>}</div>;
}
function ChoiceLabel({ choice }: { choice: PriceChoice }) {
  return <span className="v2-basket-choice"><Link to={itemHref(choice.item)}>{itemName(choice.item)}</Link>
    {choice.item.quantity && <small>Demandé : {choice.item.quantity.amount} {choice.item.quantity.unit === "package" ? "paquet(s)" : choice.item.quantity.unit === "piece" ? "pièce(s)" : choice.item.quantity.unit}</small>}
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
  const { items, remove, clear, setEnabled, setQuantity, replace, merge } = useV2Basket();
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
  async function importSharedBasket() {
    if (!sharedEntries || importing) return;
    setImporting(true);
    setImportError("");
    try {
      const incoming = await Promise.all(sharedEntries.map(async (entry): Promise<BasketItem> => {
        if (entry[0] === "g") return { kind: "group", name: entry[1], disabled: sharedEntryDisabled(entry), quantity: sharedEntryQuantity(entry) };
        if (entry[0] === "s") return { kind: "scope", department: entry[1], family: entry[2], name: entry[3], disabled: sharedEntryDisabled(entry), quantity: sharedEntryQuantity(entry) };
        let product = await productRequest<Product>("/" + entry[1]);
        if (product.merged_to_id || product.successor_id) product = await productRequest<Product>("/" + (product.merged_to_id || product.successor_id));
        return { id: product.id, revision: product.revision, data: product.data, disabled: sharedEntryDisabled(entry), quantity: sharedEntryQuantity(entry) };
      }));
      const added = merge(incoming);
      setImportNotice(added ? added + " article" + (added > 1 ? "s" : "") + " ajouté" + (added > 1 ? "s" : "") + " au panier." : "Tous ces articles sont déjà dans votre panier.");
      closeSharedLink();
    } catch {
      setImportError("Impossible de récupérer tous les produits de ce panier. Aucun article n’a été ajouté.");
    } finally { setImporting(false); }
  }
  const [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<PriceSnapshot | null>(null);
  const [filters, setFilters] = useState<BasketFilters>(emptyBasketFilters);
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [categoryError, setCategoryError] = useState(false);
  const [shown, setShown] = useState({ key: "", count: PAGE_SIZE });
  const activeItems = useMemo(() => items.filter(item => !item.disabled), [items]);
  const key = JSON.stringify(activeItems.map(item => [basketItemKey(item), advanced ? item.quantity : null])) + ":" + refresh;
  const ready = snapshot?.key === key;
  const hasComparable = items.some(item => "kind" in item);

  useEffect(() => {
    if (!hasComparable) return;
    const controller = new AbortController();
    fetch("/api/v2/catalogue/categories", { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error("Catalogue indisponible"); return response.json() as Promise<Category[]>; })
      .then(value => { if (!controller.signal.aborted) { setCategories(value); setCategoryError(false); } })
      .catch(() => { if (!controller.signal.aborted) setCategoryError(true); });
    return () => controller.abort();
  }, [hasComparable]);

  useEffect(() => {
    if (activeItems.length === 0) return;
    const controller = new AbortController();
    async function load() {
      const lines = await Promise.all(activeItems.map(async item => {
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
  }, [key, activeItems]);

  const comparison = activeItems.length && ready && snapshot ? buildBasketComparison(snapshot.lines, snapshot.responses, filters, advanced) : null;
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
  const listKey = key + ":" + JSON.stringify(filters);
  const shownCount = shown.key === listKey ? shown.count : PAGE_SIZE;
  const visibleStores = comparison?.stores.slice(0, shownCount) ?? [];
  const itemRanges = new Map<string, { min: number; max: number }>();
  const totalRanges = new Map<number, { min: number; max: number }>();
  for (const store of comparison?.stores ?? []) {
    const total = totalRanges.get(store.coverage);
    totalRanges.set(store.coverage, { min: Math.min(total?.min ?? store.cents, store.cents), max: Math.max(total?.max ?? store.cents, store.cents) });
    for (const choice of store.choices) {
      const itemKey = basketItemKey(choice.item);
      const range = itemRanges.get(itemKey);
      itemRanges.set(itemKey, { min: Math.min(range?.min ?? choice.cents, choice.cents), max: Math.max(range?.max ?? choice.cents, choice.cents) });
    }
  }
  const rangeFor = (choice: PriceChoice) => itemRanges.get(basketItemKey(choice.item)) ?? { min: choice.cents, max: choice.cents };

  return <div className="v2-home v2-recipes">
    <a className="v2-skip" href="#v2-basket-main">Aller au contenu</a>
    <header className="v2-header"><div className="v2-wrap v2-header-inner">
      <Link className="v2-brand" to="/v2">price<span className="v2-brand-accent">checker</span>.</Link>
      <nav className="v2-nav" aria-label="Navigation principale"><Link to="/v2">Accueil</Link><Link to="/v2/produits">Produits</Link><Link to="/v2/recettes">Recettes</Link><Link className="v2-nav-current" to="/v2/panier" aria-current="page">Panier</Link><Link to="/v2/parametres">Paramètres</Link>{user ? <button type="button" onClick={() => void onLogout()}>Déconnexion</button> : <Link to="/v2/connexion">Connexion</Link>}</nav>
    </div></header>
    <main id="v2-basket-main" className="v2-wrap v2-recipes-main">
      <div className="v2-recipes-heading v2-basket-heading"><div><span className="v2-section-kicker">VOS COURSES</span><div className="v2-share-title-row"><h1>Mon panier<span>.</span></h1><V2ShareButton title="Mon panier Price Checker" url={shareUrl} disabled={!items.length} /></div><p>Panier local et disponible hors ligne. Comparez les prix selon vos choix.</p></div><Link className="v2-button v2-button-secondary" to="/v2/produits">Ajouter un article →</Link></div>
      {sharedLink && <section className="v2-shared-basket" aria-label="Panier partagé">
        {sharedEntries ? <>
          <h2>Panier partagé</h2>
          <p>{sharedEntries.length} article{sharedEntries.length > 1 ? "s" : ""} dans ce lien. Les prix seront recalculés selon les magasins disponibles ; votre panier actuel est conservé.</p>
          <ul>{sharedEntries.map((entry, index) => <li key={index}>{sharedEntryName(entry)}{sharedEntryQuantity(entry) && <span> · {sharedEntryQuantity(entry)?.amount} {sharedEntryQuantity(entry)?.unit}</span>}{sharedEntryDisabled(entry) && <span> · exclu du calcul</span>}</li>)}</ul>
          <div className="v2-shared-basket-actions"><button type="button" className="v2-button v2-button-primary" disabled={importing} onClick={() => void importSharedBasket()}>{importing ? "Importation…" : "Ajouter à mon panier"}</button>
            <button type="button" className="v2-button v2-button-secondary" onClick={closeSharedLink}>Ignorer</button></div>
          {importError && <p role="alert">{importError}</p>}
        </> : <><h2>Lien de panier invalide</h2><p>Ce lien ne peut pas être ouvert.</p><button type="button" className="v2-button v2-button-secondary" onClick={closeSharedLink}>Fermer</button></>}
      </section>}
      {importNotice && <p role="status">{importNotice}</p>}
      <section className="v2-basket-mode v2-recipes-card"><label className="v2-basket-toggle"><input type="checkbox" checked={advanced} onChange={event => toggleAdvanced(event.target.checked)} />Activer le panier avancé</label>
        <p>{advanced ? "Définissez une quantité par article. Le total à payer couvre des paquets entiers ; la part utilisée est calculée au prorata lorsque la quantité du produit est connue." : "Le panier simple compare un paquet par article."}</p></section>
      {items.length ? <>
        <details className="v2-basket-editor" aria-label="Articles du panier">
          <summary>Ajuster les articles <span>{activeItems.length}/{items.length} actifs</span></summary>
          <p>Un groupe ou un ensemble compte pour un article.</p>
          <ul className="v2-basket-editor-list">{items.map(item => {
            const itemKey = basketItemKey(item);
            const choices = alternatives(item, categories ?? []);
            return <li className="v2-basket-editor-item" data-disabled={item.disabled ? "true" : "false"} key={itemKey}>
              <div className="v2-basket-editor-main"><div><span className="v2-basket-item-kind">{itemKind(item)}</span><Link to={itemHref(item)}>{itemName(item)}</Link>
                {!("kind" in item) && <small>{item.data.quantity || "Quantité non précisée"}</small>}</div>
                <label className="v2-basket-toggle"><input type="checkbox" checked={!item.disabled} onChange={event => setEnabled(item, event.target.checked)} />Inclure</label></div>
              <div className="v2-basket-editor-controls">
                {choices.length > 1 && <label>Choix de comparaison
                  <select value={itemKey} onChange={event => { const selected = choices.find(choice => basketItemKey(choice) === event.target.value); if (selected) replace(item, selected); }}>
                    {choices.map(choice => <option key={basketItemKey(choice)} value={basketItemKey(choice)} disabled={basketItemKey(choice) !== itemKey && items.some(saved => basketItemKey(saved) === basketItemKey(choice))}>{itemKind(choice)} · {choice.name}</option>)}
                  </select></label>}
                {"kind" in item && categoryError && <small>Autres choix indisponibles hors ligne.</small>}
                <button type="button" className="v2-basket-remove" onClick={() => remove(item)}>Retirer</button>
              </div>
              {advanced && <QuantityEditor key={`${itemKey}:${item.quantity?.amount}:${item.quantity?.unit}`} item={item} onChange={quantity => setQuantity(item, quantity)} />}
            </li>;
          })}</ul>
          <button type="button" className="v2-button v2-button-secondary v2-basket-clear" onClick={() => { if (window.confirm("Vider le panier ?")) clear(); }}>Vider le panier</button>
        </details>
        {activeItems.length ? <section className="v2-basket-comparison v2-recipes-card" aria-label="Comparaison des prix">
          <div className="v2-basket-comparison-heading"><div><h2>Meilleur prix</h2>
            <p>Derniers prix publiés dans les magasins filtrés. Déplacement et frais de livraison exclus.</p></div>
            <button type="button" className="v2-button v2-button-secondary" onClick={() => setRefresh(value => value + 1)}>Actualiser les prix</button></div>
          {!ready && <p role="status">Chargement des prix…</p>}
          {comparison && <>
            {comparison.failed.length > 0 && <p className="v2-recipes-error">Prix impossibles à charger pour {comparison.failed.length} article{comparison.failed.length > 1 ? "s" : ""}. Réessayez d’actualiser.</p>}
            {comparison.truncated.length > 0 && <p className="v2-recipes-error">Certains points de vente n’ont pas pu être comparés : limite de 200 par produit. Le minimum affiché peut être incomplet.</p>}
            <div className="v2-basket-split-total" aria-live="polite"><span>{comparison.missing.length ? "Sous-total réparti des articles avec prix" : "Total le moins cher en répartissant les courses"}</span>
              <strong>{comparison.split.length ? money(comparison.splitCents) : "—"}</strong>
              {advanced && comparison.split.length > 0 && <span>Part utilisée au prorata : <strong>{money(comparison.splitUsedCents)}</strong></span>}
              <small>{comparison.split.length}/{activeItems.length} articles avec un prix · {splitStores.size} point{splitStores.size > 1 ? "s" : ""} de vente</small></div>
            {splitStores.size > 0 && <details className="v2-basket-breakdown"><summary>Voir la répartition des courses</summary>
              <ul className="v2-basket-store-list">{[...splitStores].map(([storeKey, choices]) => {
                const reading = choices[0].reading;
                return <li key={storeKey} className="v2-basket-store"><div className="v2-basket-store-heading"><div><h3>{reading.retailer}</h3><p>{storeName(reading)}</p></div>
                  <div className="v2-basket-total"><strong>{money(choices.reduce((sum, choice) => sum + choice.cents, 0))}</strong>{advanced && <span>Part utilisée : {money(choices.reduce((sum, choice) => sum + choice.usedCents, 0))}</span>}<span>{choices.length} article{choices.length > 1 ? "s" : ""}</span></div></div>
                  <ul className="v2-basket-lines">{choices.map(choice => <li key={basketItemKey(choice.item)}><ChoiceLabel choice={choice} /><DatedPrice choice={choice} range={rangeFor(choice)} /></li>)}</ul>
                </li>;
              })}</ul></details>}
            {comparison.missing.length > 0 && <p className="v2-basket-missing">Sans prix ou quantité de paquet compatible : {comparison.missing.map(itemName).join(", ")}. Aucun total complet n’est calculé.</p>}
            {ready && <details className="v2-basket-filters" aria-label="Filtrer les magasins comparés">
            <summary>Filtres des magasins <span>{anyFilter ? "· actifs" : "· tous"}</span></summary>
            <p>Plusieurs choix possibles par filtre ; les filtres se cumulent.</p>
            <div className="v2-basket-filter-grid">
              <MultiFilter title="Magasins" options={storeOptions} selected={filters.storeIds} onChange={storeIds => setFilters({ ...filters, storeIds })} label={id => storeNames.get(id) ?? String(id)} />
              <MultiFilter title="Communes" options={cityOptions} selected={filters.cities} onChange={cities => setFilters({ ...filters, cities })} label={city => city} />
              <MultiFilter title="Départements" options={departmentOptions} selected={filters.departments} onChange={departments => setFilters({ ...filters, departments })} label={department => department} />
            </div>
            {anyFilter && <button type="button" className="v2-button v2-button-secondary" onClick={() => setFilters(emptyBasketFilters)}>Effacer les filtres</button>}
          </details>}
            <div className="v2-basket-results-heading"><h3>Magasins les moins chers</h3><p>Paniers complets classés par prix ; sous-totaux partiels ensuite.</p></div>
            {visibleStores.length ? <ul className="v2-basket-store-list">{visibleStores.map(store => {
              const complete = store.coverage === activeItems.length;
              return <li key={store.key} className="v2-basket-store" data-complete={complete}><div className="v2-basket-store-heading"><div><h4>{store.reading.retailer}</h4><p>{storeName(store.reading)}</p></div>
                <div className="v2-basket-total" data-price-position={complete ? pricePosition(store.cents, totalRanges.get(store.coverage)?.min ?? store.cents, totalRanges.get(store.coverage)?.max ?? store.cents) : "partial"}><strong>{money(store.cents)}</strong>{advanced && <span>Part utilisée : {money(store.choices.reduce((sum, choice) => sum + choice.usedCents, 0))}</span>}<span>{complete ? "Panier complet" : "Sous-total partiel"} · {store.coverage}/{activeItems.length} articles</span></div></div>
                <details className="v2-basket-breakdown"><summary>Voir les {store.coverage} prix</summary>
                  <ul className="v2-basket-lines">{store.choices.map(choice => <li key={basketItemKey(choice.item)}><ChoiceLabel choice={choice} /><DatedPrice choice={choice} range={rangeFor(choice)} /></li>)}</ul>
                  {!complete && <p className="v2-basket-missing">Sans prix ici : {activeItems.filter(item => !store.choices.some(choice => basketItemKey(choice.item) === basketItemKey(item))).map(itemName).join(", ")}.</p>}
                </details>
              </li>;
            })}</ul> : <p>Aucun prix comparable ne correspond à ce panier et à ces filtres.</p>}
            {comparison.stores.length > shownCount && <button type="button" className="v2-button v2-button-secondary v2-basket-load-more" onClick={() => setShown({ key: listKey, count: shownCount + PAGE_SIZE })}>Afficher 5 magasins de plus</button>}
            {hasOpenPrices && <p className="v2-basket-freshness-help">Certains relevés proviennent de <a href="https://prices.openfoodfacts.org" target="_blank" rel="noreferrer">Open Prices / Open Food Facts (ODbL)</a>.</p>}
            <p className="v2-basket-freshness-help">Montants : vert = bas, orange = intermédiaire, rouge = haut parmi les résultats comparables. Trait sous le prix : vert ≤ 30 jours, orange 31 à 90 jours, gris au-delà. Les relevés indisponibles ou contestés sont exclus.</p>
          </>}
        </section> : <div className="v2-recipes-card"><p>Activez au moins un article pour comparer les prix.</p></div>}
      </> : <div className="v2-recipes-card"><p>Votre panier est vide pour le moment. Ajoutez un produit, un groupe comparable ou un ensemble depuis le catalogue.</p></div>}
    </main>
  </div>;
}
