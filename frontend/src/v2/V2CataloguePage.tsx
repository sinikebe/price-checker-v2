import { useEffect, useMemo, useState, type FormEvent } from "react";
import V2Info from "./V2Info";
import V2ShareButton from "./V2ShareButton";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import { V2PageFrame } from "./V2SiteHeader";
import V2CatalogueSearch from "./V2CatalogueSearch";
import { SEARCH_DEBOUNCE_MS, SEARCH_MIN_CHARS, normalizeQuery } from "./v2-catalogue-search";
import type { Product } from "./v2-products-api";
import { catalogueRequest, suggest, UNCLASSIFIED, type Category, type Classification, type SearchResult } from "./v2-catalogue-data";
import V2BasketAddButtons from "./V2BasketAddButtons";
import V2OffSearch from "./V2OffSearch";
import { useSiteFilter } from "./useSiteFilter";
import { passesSiteFilter } from "./v2-site-filter";
import { bestPrices, type BestPrice, type HistoryReading } from "./v2-product-best-price";
import { useAppMode } from "./useAppMode";
import { productSizeIn, type BaseUnit } from "./v2-basket-quantity";
import { MEASURE_UNITS } from "./v2-measures";
import { CONNECTOR_PRICE_REFRESH_EVENT, useConnectorQueue } from "./v2-connector-page-refresh";
import { V2ConnectorQueueIndicator } from "./V2ConnectorQueueIndicator";
import type { BasketGroup, BasketScope } from "./v2-basket-storage";
import { usePaidPrices } from "./usePaidPrices";
import V2PriceGate from "./V2PriceGate";
import "./v2-catalogue.css";
import LevelBadge from "./V2LevelBadge";
import { CATALOGUE_DEMO_ID } from "./v2-catalogue-demo";
import { money } from "./v2-basket-view";
import { readingTime } from "./v2-calendar-day";
import { errorText, requestJson } from "./v2-http";
import { useOnline } from "./useOnline";

function browsePath(department?: string, family?: string, scope?: string): string {
  const params = new URLSearchParams();
  if (department) params.set("rayon", department);
  if (family) params.set("famille", family);
  if (scope) params.set("ensemble", scope);
  return "/v2/produits" + (params.size ? "?" + params.toString() : "");
}
type Store = { id: number; retailer: string; name: string; city: string | null; postal_code: string | null };
type PriceDetail = { name: string; products: Product[]; observations: HistoryReading[]; history_limit_per_product: number;
  /** What its prices cost (one credit per product with a price); absent offline. */
  prices_cost?: number };
type PaidObservations = Pick<PriceDetail, "observations" | "history_limit_per_product">;
type CategoryDetail = Classification & PriceDetail;
type ScopeDetail = PriceDetail & { department: string; family: string; comparison_scope: string; groups: { name: string; product_count: number }[] };
type Props = { name?: string; user: V2User | null; onLogout: () => Promise<void> };
const pageSizes = [10, 20, 50];
const colors = ["#3068aa", "#d9653b", "#229b82", "#865ac2", "#c2467e", "#af8129", "#516293", "#277482"];
type ChartMetric = BaseUnit | "price";
const metricLabels: Record<ChartMetric, string> = {
  g: "Prix au kg", ml: "Prix au litre", piece: "Prix par unité", price: "Prix du produit",
};
const metricUnits: Record<ChartMetric, string> = {
  g: "€/kg", ml: "€/L", piece: "€/unité", price: "€",
};
const chartAmount = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const chartDay = new Intl.DateTimeFormat("fr-FR");

function productName(product: Product): string {
  return [product.data.brand, product.data.name || "Produit sans nom"].filter(Boolean).join(" ");
}
function matchesSubset(product: Product, subset: string): boolean {
  const fold = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr");
  const haystack = fold([product.data.name, product.data.commercial_name, product.data.brand, ...(product.data.tags ?? [])].join(" "));
  return fold(subset.trim()).split(/\s+/).every(word => haystack.includes(word));
}
/** A catalogue answer for `path`; a new `reloadKey` asks again while the last answer stays shown. */
function useCatalogue<T>(path: string, enabled = true, reloadKey = "") {
  const [result, setResult] = useState<{ path: string; data: T | null; error: string }>({ path: "", data: null, error: "" });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const load = () => { catalogueRequest<T>(path).then(data => { if (active) setResult({ path, data, error: "" }); })
      .catch(error => { if (active) setResult({ path, data: null, error: errorText(error, "L'opération a échoué.") }); }); };
    load();
    if (path.startsWith("/categories/") || path.startsWith("/comparison?"))
      window.addEventListener(CONNECTOR_PRICE_REFRESH_EVENT, load);
    return () => { active = false; window.removeEventListener(CONNECTOR_PRICE_REFRESH_EVENT, load); };
  }, [path, enabled, reloadKey]);
  return result.path === path ? result : { path, data: null, error: "" };
}
function pageNumber(params: URLSearchParams): number {
  const value = Number(params.get("page"));
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 10000) : 1;
}
function pageSize(params: URLSearchParams): number {
  const value = Number(params.get("size"));
  return pageSizes.includes(value) ? value : 10;
}
/** The page and page size in the address, and the way to change them that keeps its other parameters. */
function usePageParams() {
  const [params, setParams] = useSearchParams();
  return {
    page: pageNumber(params), size: pageSize(params),
    changePage(nextPage: number, nextSize: number) {
      const next = new URLSearchParams(params);
      next.set("page", String(nextPage)); next.set("size", String(nextSize));
      setParams(next);
    },
  };
}
function Pagination({ total, page, size, onChange }: { total: number; page: number; size: number; onChange: (page: number, size: number) => void }) {
  if (total <= 0) return null;
  const pages = Math.max(1, Math.ceil(total / size));
  return <nav className="v2-catalogue-pagination" aria-label="Pagination">
    <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1, size)}>← Précédent</button>
    <span>Page {page} sur {pages} · {total} résultat{total > 1 ? "s" : ""}</span>
    <button type="button" disabled={page >= pages} onClick={() => onChange(page + 1, size)}>Suivant →</button>
    <label>Par page <select value={size} onChange={event => onChange(1, Number(event.target.value))}>
      {pageSizes.map(value => <option key={value} value={value}>{value}</option>)}
    </select></label>
  </nav>;
}
/** The contribution mode shows the catalogue's tools; shopping keeps names and quantities. */
const useContributing = () => useAppMode().mode === "contribute";

function ProductLink({ product, showGroup = false, price }: { product: Product; showGroup?: boolean;
  /** Shopping view of a group with its prices fetched: the lowest current price, or null without one. */
  price?: BestPrice | null }) {
  const contributing = useContributing();
  return <Link className="v2-workspace-list-item" to={"/v2/produits/" + product.id}>
    <div><LevelBadge level="product" /><strong>{productName(product)}</strong><small>{(contributing ? [showGroup && product.data.group, product.data.commercial_name, product.data.quantity || "Quantité à préciser"]
      : [product.data.quantity || "Quantité à préciser"]).filter(Boolean).join(" · ")}</small></div>
    {price !== undefined ? <span className="v2-catalogue-line-price">{price ? <><strong>{money(price.cents)}</strong>
      <small>{price.stores > 1 ? `le moins cher de ${price.stores} magasins` : price.reading.retailer}</small></> : <small>Pas de prix relevé</small>}</span>
      : <span>Voir la fiche →</span>}
  </Link>;
}
function CategoryChart({ detail, products, metric, showGroup = false }: { detail: PriceDetail; products: Product[]; metric: ChartMetric; showGroup?: boolean }) {
  const byId = new Map(products.map(product => [product.id, product]));
  const points = detail.observations.flatMap(item => {
    const product = byId.get(item.product_id);
    if (!product) return [];
    const time = readingTime(item.observed_at), price = Number(item.price);
    if (!Number.isFinite(time) || !Number.isFinite(price) || price < 0) return [];
    const quantity = metric === "price" ? null : productSizeIn(product, metric);
    if (metric !== "price" && (!quantity || price === 0)) return [];
    const amount = !quantity ? price : price * (metric === "piece" ? 1 : 1000) / quantity.amount;
    return Number.isFinite(amount) ? [{ ...item, time, amount }] : [];
  });
  const byProduct = new Map<number, typeof points>();
  for (const point of points) {
    const list = byProduct.get(point.product_id);
    if (list) list.push(point); else byProduct.set(point.product_id, [point]);
  }
  for (const list of byProduct.values()) list.sort((a, b) => a.time - b.time);
  if (!points.length) return <p>Aucun prix comparable à tracer pour cette sélection. Choisissez une autre métrique ou d’autres produits.</p>;
  const width = 760, height = 280, left = 70, right = 20, top = 18, bottom = 38;
  const times = points.map(point => point.time), amounts = points.map(point => point.amount);
  const minTime = Math.min(...times), maxTime = Math.max(...times);
  const maxPrice = Math.max(1, ...amounts) * 1.1;
  const x = (time: number) => left + (time - minTime) / (maxTime - minTime || 1) * (width - left - right);
  const y = (amount: number) => height - bottom - amount / maxPrice * (height - top - bottom);
  const dateLabel = (time: number) => chartDay.format(time);
  const amountLabel = (amount: number) => chartAmount.format(amount) + " " + metricUnits[metric];
  return <div className="v2-catalogue-chart">
    <div className="v2-catalogue-chart-scroll"><svg role="img" aria-label={"Évolution des prix de " + detail.name + " en " + metricUnits[metric]} viewBox={"0 0 " + width + " " + height}>
      <line x1={left} y1={top} x2={left} y2={height - bottom} stroke="currentColor" />
      <line x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} stroke="currentColor" />
      <text x={left - 8} y={top + 4} textAnchor="end">{amountLabel(maxPrice)}</text>
      <text x={left - 8} y={height - bottom + 4} textAnchor="end">{amountLabel(0)}</text>
      <text x={left} y={height - 9}>{dateLabel(minTime)}</text>
      <text x={width - right} y={height - 9} textAnchor="end">{dateLabel(maxTime)}</text>
      {products.map((product, index) => {
        const series = byProduct.get(product.id) ?? [];
        const color = colors[index % colors.length];
        return <g key={product.id}>
          {series.length > 1 && <polyline fill="none" stroke={color} strokeWidth="2.5"
            points={series.map(point => x(point.time) + "," + y(point.amount)).join(" ")} />}
          {series.map(point => <circle key={point.id} cx={x(point.time)} cy={y(point.amount)} r="4" fill={color}>
            <title>{productName(product) + " · " + dateLabel(point.time) + " · " + amountLabel(point.amount) + " · " + point.retailer}</title>
          </circle>)}
        </g>;
      })}
    </svg></div>
    <ul className="v2-catalogue-legend">{products.map((product, index) =>
      <li key={product.id}><span style={{ backgroundColor: colors[index % colors.length] }} /><Link to={"/v2/produits/" + product.id}>{productName(product)}</Link>{showGroup && <small> · {product.data.group || "Sans groupe"}</small>}
        {!byProduct.has(product.id) && <small> · {metric !== "price" && !productSizeIn(product, metric) ? "quantité non comparable" : "aucun prix"}</small>}</li>
    )}</ul>
    <p className="v2-catalogue-source">Ces prix sont des relevés tiers, non vérifiés par Price Checker. Source : <a href="https://prices.openfoodfacts.org" target="_blank" rel="noreferrer">Open Prices / Open Food Facts</a> (ODbL). <V2Info>Historique : jusqu’à {detail.history_limit_per_product} points récents par produit. Les signalements Open Prices consécutifs au même prix sont résumés par le premier et le dernier jour de la période.{metric !== "price" && products.some(product => !productSizeIn(product, metric)) && ` Les produits sans quantité compatible avec ${metricUnits[metric]} restent dans la liste, mais ne sont pas tracés.`}</V2Info></p>
  </div>;
}
const NOT_CLASSIFIED = "Le classement n’a pas été enregistré.";
function ClassificationEditor({ name, current, onSaved }: {
  name: string; current: Classification; onSaved: (value: Classification) => void;
}) {
  const [department, setDepartment] = useState(current.department === UNCLASSIFIED ? "" : current.department);
  const [family, setFamily] = useState(current.family === UNCLASSIFIED ? "" : current.family);
  const [scope, setScope] = useState(current.comparison_scope || "");
  const categoryList = useCatalogue<Category[]>("/categories").data ?? [];
  const scopeOptions = [...new Set(categoryList.filter(item => item.department === department && item.family === family)
    .map(item => item.comparison_scope).filter((value): value is string => Boolean(value)))];
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [success, setSuccess] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setSuccess("");
    try {
      const updated = await requestJson<Classification>("/api/v2/catalogue/categories/" + encodeURIComponent(name) + "/classification", {
        method: "PUT", fallback: NOT_CLASSIFIED,
        body: { department: department.trim(), family: family.trim(), comparison_scope: scope.trim() || null,
          base_revision: current.classification_revision },
      });
      onSaved(updated);
      setSuccess("Classement enregistré pour tout le groupe comparable.");
    } catch (cause) { setError(errorText(cause, NOT_CLASSIFIED)); }
    finally { setBusy(false); }
  }
  return <form className="v2-catalogue-classification" onSubmit={save}>
    <h2>Classement du groupe <V2Info>Ce classement concerne tous les produits du groupe, sans modifier leur groupe comparable ni leurs prix.{current.classification_source !== "manual" && " Valeurs préremplies à vérifier ; elles peuvent être corrigées ici."}</V2Info></h2>
    <fieldset disabled={busy}>
      <label>Rayon <input required maxLength={80} value={department} onChange={event => setDepartment(event.target.value)} /></label>
      <label>Famille <input required maxLength={80} value={family} onChange={event => setFamily(event.target.value)} /></label>
      <label>Ensemble de comparaison (facultatif) <V2Info>Les groupes du même rayon et de la même famille portant ce nom seront comparés ensemble. Laissez vide pour afficher le groupe directement.</V2Info>
        <input maxLength={80} list="v2-comparison-scope-options" value={scope} onChange={event => setScope(event.target.value)}
          placeholder="Ex. Jus d’orange" />
        <datalist id="v2-comparison-scope-options">{scopeOptions.map(value => <option key={value} value={value} />)}</datalist>
      </label>
      <button className="v2-button v2-button-secondary" type="submit">Enregistrer le classement</button>
    </fieldset>
    {error && <p role="alert">{error}</p>}{success && <p role="status">{success}</p>}
  </form>;
}

function ComparisonContent({ detail, showGroup = false, awaitingPrices = false, admin = false }: { detail: PriceDetail; showGroup?: boolean; awaitingPrices?: boolean; admin?: boolean }) {
  const [params, setParams] = useSearchParams();
  const { page, size, changePage } = usePageParams();
  const subset = params.get("subset") || "";
  const products = detail.products;
  const selectedProducts = products.filter(product => matchesSubset(product, subset));
  const queueBadges = useConnectorQueue(selectedProducts.map(product => product.id), admin);
  const online = useOnline();
  const availableMetrics = MEASURE_UNITS.map(unit => ({
    unit, count: selectedProducts.filter(product => productSizeIn(product, unit)).length,
  })).filter(item => item.count > 0).sort((a, b) => b.count - a.count);
  const requestedMetric = params.get("metric");
  const metric: ChartMetric = requestedMetric === "price" || availableMetrics.some(item => item.unit === requestedMetric)
    ? requestedMetric as ChartMetric : availableMetrics[0]?.unit || "price";
  function changeSubset(value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set("subset", value);
    else next.delete("subset");
    next.set("page", "1");
    setParams(next, { replace: true });
  }
  function changeMetric(value: string) {
    const next = new URLSearchParams(params);
    next.set("metric", value);
    setParams(next);
  }
  return <>
    <div className="v2-catalogue-detail-controls">
      <label htmlFor="category-subset">Produits à garder <V2Info>Filtre le nom, le nom commercial et les mots-clés des produits.</V2Info>
        <input id="category-subset" type="search" value={subset} onChange={event => changeSubset(event.target.value)}
          placeholder="Ex. sans pulpe" />
      </label>
      <label htmlFor="category-metric">Métrique du graphique
        <select id="category-metric" value={metric} onChange={event => changeMetric(event.target.value)}>
          {availableMetrics.map(item => <option key={item.unit} value={item.unit}>{metricLabels[item.unit]}</option>)}
          <option value="price">{metricLabels.price}</option>
        </select>
      </label>
    </div>
    <p role="status">{selectedProducts.length} produit{selectedProducts.length > 1 ? "s" : ""} affiché{selectedProducts.length > 1 ? "s" : ""} sur {products.length}.</p>
    {selectedProducts.length ? <>
      <h2>Prix des produits sélectionnés</h2>
      {queueBadges.length > 0 && <div role="status" aria-label="Relevés en file">{queueBadges.map(badge =>
        <span key={`${badge.connectorId}:${badge.productId}`}>
          {productName(selectedProducts.find(product => product.id === badge.productId)!)} · {badge.connector} :
          <V2ConnectorQueueIndicator badge={badge} />
        </span>)}</div>}
      {!online && <p>Hors ligne : les relevés de prix ne sont pas conservés dans ce catalogue local.</p>}
      {awaitingPrices ? <p className="v2-catalogue-source">Les prix s’affichent ici une fois récupérés.</p> : <CategoryChart detail={detail} products={selectedProducts} metric={metric} showGroup={showGroup} />}
      <h2>Produits</h2>
      <div className="v2-workspace-list">{selectedProducts.slice((page - 1) * size, page * size).map(product =>
        <ProductLink key={product.id} product={product} showGroup={showGroup} />)}</div>
      <Pagination total={selectedProducts.length} page={page} size={size} onChange={changePage} />
    </> : <p>Aucun produit ne correspond à ce filtre.</p>}
  </>;
}

/** Shopping: the products of a group, by name and quantity, without prices or charts. */
function SimpleProducts({ products, prices }: { products: Product[];
  /** The lowest current price of each product, once the page's prices are fetched (filtered by the site filter). */
  prices?: Map<number, BestPrice> }) {
  const { page, size, changePage } = usePageParams();
  if (!products.length) return <p>Aucun produit publié dans ce groupe pour le moment.</p>;
  return <>
    <h2>Produits</h2>
    <div className="v2-workspace-list">{products.slice((page - 1) * size, page * size).map(product =>
      <ProductLink key={product.id} product={product} price={prices ? prices.get(product.id) ?? null : undefined} />)}</div>
    <Pagination total={products.length} page={page} size={size} onChange={changePage} />
  </>;
}

function CategoryPage({ name, user, onLogout }: Props & { name: string }) {
  const contributing = useContributing();
  const basketGroup: BasketGroup = { kind: "group", name };
  const { data, error } = useCatalogue<CategoryDetail>("/categories/" + encodeURIComponent(name));
  const groupName = data?.name || name;
  // Prices cost one credit per product with a price: said on the button, spent only on request.
  const paid = usePaidPrices<PaidObservations>(user?.id ?? null, "category", data && data.prices_cost !== undefined ? groupName : null,
    data?.prices_cost ?? 0, cost => "/api/v2/catalogue/prices/category?" + new URLSearchParams({ name: groupName, max_cost: String(cost) }));
  // The account's site-wide store filter, when on, keeps the readings of its stores only.
  const site = useSiteFilter().active;
  const observations = useMemo(() => (paid.data?.observations ?? data?.observations ?? []).filter(row => passesSiteFilter(row, site)),
    [paid.data, data, site]);
  const priced = data ? { ...data, observations } : null;
  const lowest = useMemo(() => paid.data ? bestPrices(observations) : undefined, [paid.data, observations]);
  const [savedClassification, setSavedClassification] = useState<Classification | null>(null);
  const classification = savedClassification ?? data;
  const products = data?.products ?? [];
  const gate = data && data.prices_cost !== undefined ? <V2PriceGate paid={paid} subject="ce groupe" /> : null;
  return <V2PageFrame user={user} onLogout={onLogout}>
    <nav className="v2-catalogue-crumbs" aria-label="Fil d’Ariane">
      <Link to="/v2/produits"><LevelBadge level="department" /> Rayons</Link>
      {classification && <>
        <Link to={browsePath(classification.department)}><LevelBadge level="department" /> {classification.department}</Link>
        <Link to={browsePath(classification.department, classification.family)}><LevelBadge level="family" /> {classification.family}</Link>
        {classification.comparison_scope && <Link to={browsePath(classification.department, classification.family, classification.comparison_scope)}>
          <LevelBadge level="scope" /> {classification.comparison_scope}</Link>}
      </>}
    </nav>
    <div className="v2-workspace-heading"><div><LevelBadge level="group" />
      <div className="v2-share-title-row"><h1>{data?.name || name}<span>.</span></h1>
      {data && <V2ShareButton title={"Groupe comparable · " + (data.name || name)} url={window.location.origin + "/v2/categories/" + encodeURIComponent(data.name || name)} />}</div><p>{products.length} produit{products.length > 1 ? "s" : ""} dans ce groupe.</p></div>
      {data && <V2BasketAddButtons item={basketGroup} what="group" />}</div>
    {error ? <p role="alert">{error}</p> : !data ? <p>Chargement…</p> : !contributing ? <>
      {gate}
      {site && paid.data && <p className="v2-catalogue-source" role="status">Filtre de magasins du site actif : seuls ses magasins comptent.</p>}
      <SimpleProducts products={products} prices={lowest} />
    </> : <>
      {user?.role === "admin" && classification && <ClassificationEditor key={name} name={name} current={classification} onSaved={setSavedClassification} />}
      {gate}
      <ComparisonContent admin={user?.role === "admin"} detail={priced ?? data} awaitingPrices={data.prices_cost !== undefined && !paid.data && !paid.credits?.unlimited} />
    </>}
  </V2PageFrame>;
}

function ScopePage({ department, family, scope, user, onLogout }: Props & { department: string; family: string; scope: string }) {
  const contributing = useContributing();
  const basketScope: BasketScope = { kind: "scope", name: scope, department, family };
  const query = new URLSearchParams({ department, family, scope });
  const { data, error } = useCatalogue<ScopeDetail>("/comparison?" + query.toString());
  const paid = usePaidPrices<PaidObservations>(user?.id ?? null, "comparison", data && data.prices_cost !== undefined ? [department, family, scope].join("|") : null,
    data?.prices_cost ?? 0, cost => "/api/v2/catalogue/prices/comparison?" + new URLSearchParams({ department, family, scope, max_cost: String(cost) }));
  const site = useSiteFilter().active;
  const priced = data ? { ...data, observations: (paid.data?.observations ?? data.observations).filter(row => passesSiteFilter(row, site)) } : null;
  return <V2PageFrame user={user} onLogout={onLogout}>
    <nav className="v2-catalogue-crumbs" aria-label="Fil d’Ariane">
      <Link to="/v2/produits"><LevelBadge level="department" /> Rayons</Link>
      <Link to={browsePath(department)}><LevelBadge level="department" /> {department}</Link>
      <Link to={browsePath(department, family)}><LevelBadge level="family" /> {family}</Link>
    </nav>
    <div className="v2-workspace-heading"><div><LevelBadge level="scope" />
      <div className="v2-share-title-row"><h1>{scope}<span>.</span> <V2Info>{contributing ? "Comparez les prix de tous les groupes de cet ensemble, ou ouvrez un groupe précis." : "Les groupes de produits de cet ensemble."}</V2Info></h1>
      {data && <V2ShareButton title={"Ensemble · " + scope} url={window.location.origin + browsePath(department, family, scope)} />}</div></div>
      {data && <V2BasketAddButtons item={basketScope} what="scope" />}</div>
    {error ? <p role="alert">{error}</p> : !data ? <p>Chargement…</p> : <>
      <h2>Groupes comparables inclus</h2>
      <div className="v2-workspace-list">{data.groups.map(group =>
        <Link key={group.name} className="v2-workspace-list-item" to={"/v2/categories/" + encodeURIComponent(group.name)}>
          <div><LevelBadge level="group" /><strong>{group.name}</strong><small>{group.product_count} produit{group.product_count > 1 ? "s" : ""}</small></div>
          <span>{contributing ? "Comparer ce groupe →" : "Voir les produits →"}</span>
        </Link>)}</div>
      {contributing && data.prices_cost !== undefined && <V2PriceGate paid={paid} subject="cet ensemble" />}
      {contributing && <ComparisonContent admin={user?.role === "admin"} detail={priced ?? data} showGroup awaitingPrices={data.prices_cost !== undefined && !paid.data && !paid.credits?.unlimited} />}
    </>}
  </V2PageFrame>;
}

function CatalogueIndex({ user, onLogout, categories }: Props & {
  /** Read by the page around it: the last list stays shown while the next step of the index loads. */
  categories: { data: Category[] | null; error: string };
}) {
  const contributing = useContributing();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "", category = params.get("category") || "";
  const department = params.get("rayon") || "", family = params.get("famille") || "";
  const storeId = Number(params.get("store") || 0), storeLabel = params.get("store_label") || "";
  const { page, size, changePage } = usePageParams();
  const [queryDraft, setQueryDraft] = useState(q), [categoryDraft, setCategoryDraft] = useState(category);
  // From two characters the search follows the typing; before that, the filters and the browsing view apply.
  const dynamicActive = normalizeQuery(queryDraft).length >= SEARCH_MIN_CHARS;
  const searching = !dynamicActive && Boolean(q || category || storeId);
  const [storeDraft, setStoreDraft] = useState(storeLabel), [selectedStore, setSelectedStore] = useState(storeId);
  const [stores, setStores] = useState<Store[]>([]);
  const [filterError, setFilterError] = useState("");
  const searchParams = new URLSearchParams({ q, category, limit: String(size), offset: String((page - 1) * size) });
  if (storeId) searchParams.set("store_id", String(storeId));
  const search = useCatalogue<SearchResult>("/search?" + searchParams.toString(), searching);
  useEffect(() => {
    if (storeDraft.trim().length < 2 || selectedStore) return;
    let active = true;
    // Fast typing makes one request, for the last text.
    const timer = window.setTimeout(() => {
      catalogueRequest<Store[]>("/stores?q=" + encodeURIComponent(storeDraft.trim()))
        .then(value => { if (active) setStores(value); }).catch(() => { if (active) setStores([]); });
    }, SEARCH_DEBOUNCE_MS);
    return () => { active = false; window.clearTimeout(timer); };
  }, [storeDraft, selectedStore]);
  function apply(event: FormEvent) {
    event.preventDefault();
    if (storeDraft.trim() && !selectedStore) { setFilterError("Choisissez un magasin dans les suggestions, ou effacez ce champ."); return; }
    setFilterError("");
    const next = new URLSearchParams({ page: "1", size: String(size) });
    if (queryDraft.trim()) next.set("q", queryDraft.trim());
    if (categoryDraft) next.set("category", categoryDraft);
    if (selectedStore) { next.set("store", String(selectedStore)); next.set("store_label", storeDraft); }
    setParams(next);
  }
  const categoryList = categories.data ?? [];
  const departments = new Map<string, number>(), families = new Map<string, number>();
  for (const item of categoryList) {
    departments.set(item.department, (departments.get(item.department) || 0) + item.product_count);
    if (item.department === department)
      families.set(item.family, (families.get(item.family) || 0) + item.product_count);
  }
  const sortedDepartments = [...departments].sort(([a], [b]) => a.localeCompare(b, "fr"));
  const sortedFamilies = [...families].sort(([a], [b]) => a.localeCompare(b, "fr"));
  const groups = categoryList.filter(item => item.department === department && item.family === family);
  const scopeCounts = new Map<string, { name: string; count: number }>();
  for (const item of groups) if (item.comparison_scope) {
    const key = item.comparison_scope.toLocaleLowerCase("fr");
    const current = scopeCounts.get(key);
    if (current) current.count += item.product_count;
    else scopeCounts.set(key, { name: item.comparison_scope, count: item.product_count });
  }
  const scopes = [...scopeCounts.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  const directGroups = groups.filter(item => !item.comparison_scope);
  const familyEntries: ({ kind: "scope"; name: string; count: number } | { kind: "group"; name: string; count: number })[] = [
    ...scopes.map(({ name, count }) => ({ kind: "scope" as const, name, count })),
    ...directGroups.map(item => ({ kind: "group" as const, name: item.name, count: item.product_count })),
  ];
  const result = search.data;
  return <V2PageFrame user={user} onLogout={onLogout}>
    <div className="v2-workspace-heading"><div><span className="v2-section-kicker">CATALOGUE V2</span><h1>Produits<span>.</span> <V2Info>{contributing ? "Parcourez les rayons, familles, ensembles facultatifs et groupes comparables, ou recherchez une référence."
        : "Parcourez les rayons ou recherchez un produit, puis ajoutez-le à votre panier."}</V2Info></h1></div>
      {contributing && <Link className="v2-button v2-button-primary" to="/v2/produits/nouveau">Ajouter un produit →</Link>}
    </div>
    {!contributing && <p className="v2-catalogue-test-note" role="note"><strong>Catalogue de test.</strong> Cette liste de produits sert aux essais
      et il lui manque encore beaucoup de produits. <Link to={"/v2#" + CATALOGUE_DEMO_ID}>Voir un exemple de rangement</Link></p>}
    <V2CatalogueSearch value={queryDraft} onChange={setQueryDraft} scope={{ category, storeId }} suggest={suggest}
      onSubmitText={text => { const next = new URLSearchParams(params); next.set("q", text); next.set("page", "1"); setParams(next); }}
      renderProduct={product => <ProductLink product={product} />}>
    <form className="v2-catalogue-search" onSubmit={apply}>
      <details className="v2-catalogue-filters" open={Boolean(category || storeId) || undefined}><summary>Filtres {category || storeId ? "· actifs" : contributing ? "· groupe et magasin" : "· groupe"}</summary>
        <div className="v2-catalogue-filter-fields">
          <label>Groupe comparable <select value={categoryDraft} onChange={event => setCategoryDraft(event.target.value)}>
            <option value="">Tous les groupes</option>{categoryList.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select></label>
          {contributing && <div className="v2-catalogue-store"><label htmlFor="catalogue-store">Magasin</label>
            <input id="catalogue-store" value={storeDraft} autoComplete="off" placeholder="Nom ou ville (2 caractères min.)"
              onChange={event => { setStoreDraft(event.target.value); setSelectedStore(0); setStores([]); }} />
            {stores.length > 0 && <div className="v2-catalogue-suggestions">{stores.map(store => <button key={store.id} type="button"
              onClick={() => { setSelectedStore(store.id); setStoreDraft([store.retailer, store.name, store.city].filter(Boolean).join(" · ")); setStores([]); }}>
              {[store.retailer, store.name, store.city].filter(Boolean).join(" · ")}</button>)}</div>}
            {selectedStore > 0 && <small>Magasin sélectionné. Effacez le champ pour changer.</small>}
          </div>}
        </div>
        <button type="submit" className="v2-button v2-button-secondary">Appliquer les filtres</button>
      </details>
      {filterError && <p role="alert">{filterError}</p>}
    </form>
    </V2CatalogueSearch>
    {normalizeQuery(queryDraft).length >= SEARCH_MIN_CHARS && <V2OffSearch query={queryDraft} submitted={q} />}
    {dynamicActive ? null : searching ? <>
      <div className="v2-catalogue-result-heading"><h2>Références</h2><Link to="/v2/produits">Effacer les filtres</Link></div>
      {search.error ? <p role="alert">{search.error}</p> : !result ? <p>Recherche…</p>
        : result.total === 0 ? <p>Aucun produit trouvé.</p> : <>
          <div className="v2-workspace-list">{result.items.map(product => <ProductLink key={product.id} product={product} />)}</div>
          <Pagination total={result.total} page={page} size={size} onChange={changePage} />
        </>}
    </> : <>
      <nav className="v2-catalogue-crumbs" aria-label="Fil d’Ariane">
        <Link to="/v2/produits"><LevelBadge level="department" /> Rayons</Link>
        {department && <Link to={browsePath(department)}><LevelBadge level="department" /> {department}</Link>}
        {family && <span><LevelBadge level="family" /> {family}</span>}
      </nav>
      <h2>{family ? scopes.length ? "Ensembles et groupes comparables" : "Groupes comparables" : department ? "Familles" : "Rayons"}</h2>
      {categories.error ? <p role="alert">{categories.error}</p> : !categories.data ? <p>Chargement…</p>
        : !categoryList.length ? <p>Aucun produit publié.</p> : !department ? (
          <div className="v2-workspace-list">{sortedDepartments.map(([name, count]) =>
            <Link key={name} className="v2-workspace-list-item" to={browsePath(name)}>
              <div><LevelBadge level="department" /><strong>{name}</strong><small>{count} produit{count > 1 ? "s" : ""}</small></div>
              <span>Voir les familles →</span>
            </Link>)}</div>
        ) : !family ? (
          sortedFamilies.length ? <div className="v2-workspace-list">{sortedFamilies.map(([name, count]) =>
            <Link key={name} className="v2-workspace-list-item" to={browsePath(department, name)}>
              <div><LevelBadge level="family" /><strong>{name}</strong><small>{count} produit{count > 1 ? "s" : ""}</small></div>
              <span>Voir les ensembles et groupes →</span>
            </Link>)}</div> : <p>Aucune famille dans ce rayon.</p>
        ) : familyEntries.length ? <>
          <div className="v2-workspace-list">{familyEntries.slice((page - 1) * size, page * size).map(item =>
            <Link key={item.kind + item.name} className="v2-workspace-list-item"
              to={item.kind === "scope" ? browsePath(department, family, item.name) : "/v2/categories/" + encodeURIComponent(item.name)}>
              <div><LevelBadge level={item.kind} /><strong>{item.name}</strong>
                <small>{item.count} produit{item.count > 1 ? "s" : ""}</small></div>
              <span>{!contributing ? "Voir les produits →" : item.kind === "scope" ? "Comparer tout l’ensemble →" : "Comparer ce groupe →"}</span>
            </Link>)}</div>
          <Pagination total={familyEntries.length} page={page} size={size} onChange={changePage} />
        </> : <p>Aucun groupe dans cette famille.</p>}
    </>}
  </V2PageFrame>;
}
export default function V2CataloguePage(props: Props) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const department = params.get("rayon") || "", family = params.get("famille") || "", scope = params.get("ensemble") || "";
  // The index reads the categories again at each step (a reclassification shows), keeping the last ones meanwhile.
  const indexShown = !props.name && !(department && family && scope);
  const categories = useCatalogue<Category[]>("/categories", indexShown, location.search);
  return props.name ? <CategoryPage key={props.name} {...props} name={props.name} />
    : department && family && scope ? <ScopePage {...props} department={department} family={family} scope={scope} />
    : <CatalogueIndex key={location.search} {...props} categories={categories} />;
}
