import { useEffect, useState, type FormEvent } from "react";
import V2ShareButton from "./V2ShareButton";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import { Frame } from "./V2ProductWorkspace";
import V2BarcodeSearch from "./V2BarcodeSearch";
import { productRequest, type Product } from "./v2-products-api";
import { useV2Basket } from "./V2BasketContext";
import type { BasketGroup, BasketScope } from "./v2-basket-storage";
import "./v2-catalogue.css";

type Classification = {
  department: string; family: string; comparison_scope: string | null; classification_source: string; classification_revision: number;
};
type Category = Classification & { name: string; product_count: number };
const UNCLASSIFIED = "À classer";
const NAV_CACHE_KEY = "price-checker-v2-catalogue-classifications";
function cachedCategories(): Category[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(NAV_CACHE_KEY) || "[]");
    return Array.isArray(value) ? value as Category[] : [];
  } catch { return []; }
}
function locationFor(name: string, cached: Category[]): Classification {
  return cached.find(item => item.name.toLocaleLowerCase("fr") === name.toLocaleLowerCase("fr"))
    ?? { department: UNCLASSIFIED, family: UNCLASSIFIED, comparison_scope: null, classification_source: "unclassified", classification_revision: 0 };
}
function browsePath(department?: string, family?: string, scope?: string): string {
  const params = new URLSearchParams();
  if (department) params.set("rayon", department);
  if (family) params.set("famille", family);
  if (scope) params.set("ensemble", scope);
  return "/v2/produits" + (params.size ? "?" + params.toString() : "");
}
type Level = "department" | "family" | "scope" | "group" | "product";
const levelLabels: Record<Level, string> = {
  department: "Rayon", family: "Famille", scope: "Ensemble", group: "Groupe comparable", product: "Produit",
};
const levelPaths: Record<Level, string> = {
  department: "M3 21V5h18v16M7 5V3h10v2M7 9h2m6 0h2M7 13h2m6 0h2M10 21v-5h4v5",
  family: "M3 7h6l2 2h10v11H3zM3 7V5h6l2 2",
  scope: "M8 5a7 7 0 1 0 0 14m8-14a7 7 0 1 1 0 14M5 12h14",
  group: "M5 7h14M5 12h14M5 17h14M3 7h0m0 5h0m0 5h0",
  product: "M5 8 12 4l7 4v10l-7 4-7-4zM5 8l7 4 7-4m-7 4v10",
};
function LevelBadge({ level }: { level: Level }) {
  return <span className={"v2-catalogue-level v2-catalogue-level-" + level}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={levelPaths[level]} />
    </svg><span>{levelLabels[level]}</span>
  </span>;
}
type Store = { id: number; retailer: string; name: string; city: string | null; postal_code: string | null };
type SearchResult = { items: Product[]; total: number; limit: number; offset: number };
type Observation = { id: number; product_id: number; price: string; observed_at: string; retailer: string; store_name: string; city: string | null };
type PriceDetail = { name: string; products: Product[]; observations: Observation[]; history_limit_per_product: number };
type CategoryDetail = Classification & PriceDetail;
type ScopeDetail = PriceDetail & { department: string; family: string; comparison_scope: string; groups: { name: string; product_count: number }[] };
type Props = { name?: string; user: V2User | null; onLogout: () => Promise<void> };
const pageSizes = [10, 20, 50];
const colors = ["#3068aa", "#d9653b", "#229b82", "#865ac2", "#c2467e", "#af8129", "#516293", "#277482"];
type UnitMetric = "g" | "ml" | "piece";
type ChartMetric = UnitMetric | "price";
const unitMetrics: UnitMetric[] = ["g", "ml", "piece"];
const metricLabels: Record<ChartMetric, string> = {
  g: "Prix au kg", ml: "Prix au litre", piece: "Prix par unité", price: "Prix du produit",
};
const metricUnits: Record<ChartMetric, string> = {
  g: "€/kg", ml: "€/L", piece: "€/unité", price: "€",
};

function productName(product: Product): string {
  return [product.data.brand, product.data.name || "Produit sans nom"].filter(Boolean).join(" ");
}
function quantityFor(product: Product): { amount: number; unit: UnitMetric } | null {
  const amount = Number(product.data.quantity_amount);
  const unit = product.data.quantity_unit;
  return Number.isFinite(amount) && amount > 0 && unit && unitMetrics.includes(unit)
    ? { amount, unit } : null;
}
function matchesSubset(product: Product, subset: string): boolean {
  const fold = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr");
  const haystack = fold([product.data.name, product.data.commercial_name, product.data.brand, ...(product.data.tags ?? [])].join(" "));
  return fold(subset.trim()).split(/\s+/).every(word => haystack.includes(word));
}
async function offlineCatalogue(path: string): Promise<unknown> {
  const products = await productRequest<Product[]>("");
  const group = (item: Product) => item.data.group?.trim() || "Sans groupe";
  if (path === "/categories") {
    const counts = new Map<string, Category>();
    const cached = cachedCategories();
    for (const product of products) {
      const name = group(product), key = name.toLocaleLowerCase("fr");
      const entry = counts.get(key);
      if (entry) entry.product_count++;
      else counts.set(key, { name, product_count: 1, ...locationFor(name, cached) });
    }
    return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }
  if (path.startsWith("/categories/")) {
    const name = decodeURIComponent(path.slice("/categories/".length));
    const matches = products.filter(product => group(product).toLocaleLowerCase("fr") === name.toLocaleLowerCase("fr"));
    if (!matches.length) throw new Error("Catégorie introuvable dans le catalogue local.");
    return { name, ...locationFor(name, cachedCategories()), products: matches, observations: [], history_limit_per_product: 30 };
  }
  if (path.startsWith("/comparison?")) {
    const params = new URLSearchParams(path.slice("/comparison?".length));
    const department = params.get("department") || "", family = params.get("family") || "", scope = params.get("scope") || "";
    const cached = cachedCategories();
    const members = cached.filter(item => item.department.toLocaleLowerCase("fr") === department.toLocaleLowerCase("fr")
      && item.family.toLocaleLowerCase("fr") === family.toLocaleLowerCase("fr")
      && item.comparison_scope?.toLocaleLowerCase("fr") === scope.toLocaleLowerCase("fr"));
    if (!members.length) throw new Error("Ensemble introuvable dans le catalogue local.");
    const names = new Set(members.map(item => item.name.toLocaleLowerCase("fr")));
    return { name: scope, department, family, comparison_scope: scope,
      groups: members.map(item => ({ name: item.name, product_count: item.product_count })),
      products: products.filter(product => names.has(group(product).toLocaleLowerCase("fr"))),
      observations: [], history_limit_per_product: 30 };
  }
  if (path.startsWith("/search?")) {
    const params = new URLSearchParams(path.slice("/search?".length));
    if (params.get("store_id")) throw new Error("Le filtre magasin nécessite une connexion.");
    const query = (params.get("q") || "").toLocaleLowerCase("fr");
    const category = (params.get("category") || "").toLocaleLowerCase("fr");
    const matches = products.filter(product => {
      const data = product.data;
      return (!category || group(product).toLocaleLowerCase("fr") === category)
        && (!query || [data.brand, data.name, data.commercial_name, data.quantity, data.ean]
          .join(" ").toLocaleLowerCase("fr").includes(query));
    });
    const limit = Number(params.get("limit") || 10), offset = Number(params.get("offset") || 0);
    return { items: matches.slice(offset, offset + limit), total: matches.length, limit, offset };
  }
  throw new Error("Cette recherche n’est pas disponible hors ligne.");
}
async function catalogueRequest<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/v2/catalogue" + path, { credentials: "same-origin" });
  } catch (error) {
    if (error instanceof TypeError) return offlineCatalogue(path) as Promise<T>;
    throw error;
  }
  if (!response.ok) throw new Error("Le catalogue est indisponible (" + response.status + ").");
  const data = await response.json() as T;
  if (path === "/categories") {
    try { localStorage.setItem(NAV_CACHE_KEY, JSON.stringify(data)); } catch { /* optional public cache */ }
  }
  return data;
}
function useCatalogue<T>(path: string, enabled = true) {
  const [result, setResult] = useState<{ path: string; data: T | null; error: string }>({ path: "", data: null, error: "" });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    catalogueRequest<T>(path).then(data => { if (active) setResult({ path, data, error: "" }); })
      .catch(error => { if (active) setResult({ path, data: null, error: String(error) }); });
    return () => { active = false; };
  }, [path, enabled]);
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
function ProductLink({ product, showGroup = false }: { product: Product; showGroup?: boolean }) {
  return <Link className="v2-workspace-list-item" to={"/v2/produits/" + product.id}>
    <div><LevelBadge level="product" /><strong>{productName(product)}</strong><small>{[showGroup && product.data.group, product.data.commercial_name, product.data.quantity || "Quantité à préciser"].filter(Boolean).join(" · ")}</small></div>
    <span>Voir la fiche →</span>
  </Link>;
}
function CategoryChart({ detail, products, metric, showGroup = false }: { detail: PriceDetail; products: Product[]; metric: ChartMetric; showGroup?: boolean }) {
  const byId = new Map(products.map(product => [product.id, product]));
  const points = detail.observations.flatMap(item => {
    const product = byId.get(item.product_id);
    if (!product) return [];
    const time = Date.parse(item.observed_at), price = Number(item.price);
    if (!Number.isFinite(time) || !Number.isFinite(price) || price < 0) return [];
    const quantity = quantityFor(product);
    if (metric !== "price" && (!quantity || quantity.unit !== metric || price === 0)) return [];
    const amount = metric === "price" ? price : price * (metric === "piece" ? 1 : 1000) / quantity!.amount;
    return Number.isFinite(amount) ? [{ ...item, time, amount }] : [];
  });
  if (!points.length) return <p>Aucun prix comparable à tracer pour cette sélection. Choisissez une autre métrique ou d’autres produits.</p>;
  const width = 760, height = 280, left = 70, right = 20, top = 18, bottom = 38;
  const times = points.map(point => point.time), amounts = points.map(point => point.amount);
  const minTime = Math.min(...times), maxTime = Math.max(...times);
  const maxPrice = Math.max(1, ...amounts) * 1.1;
  const x = (time: number) => left + (time - minTime) / (maxTime - minTime || 1) * (width - left - right);
  const y = (amount: number) => height - bottom - amount / maxPrice * (height - top - bottom);
  const dateLabel = (time: number) => new Date(time).toLocaleDateString("fr-FR");
  const amountLabel = (amount: number) => amount.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + metricUnits[metric];
  return <div className="v2-catalogue-chart">
    <div className="v2-catalogue-chart-scroll"><svg role="img" aria-label={"Évolution des prix de " + detail.name + " en " + metricUnits[metric]} viewBox={"0 0 " + width + " " + height}>
      <line x1={left} y1={top} x2={left} y2={height - bottom} stroke="currentColor" />
      <line x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} stroke="currentColor" />
      <text x={left - 8} y={top + 4} textAnchor="end">{amountLabel(maxPrice)}</text>
      <text x={left - 8} y={height - bottom + 4} textAnchor="end">{amountLabel(0)}</text>
      <text x={left} y={height - 9}>{dateLabel(minTime)}</text>
      <text x={width - right} y={height - 9} textAnchor="end">{dateLabel(maxTime)}</text>
      {products.map((product, index) => {
        const series = points.filter(point => point.product_id === product.id).sort((a, b) => a.time - b.time);
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
        {!points.some(point => point.product_id === product.id) && <small> · {metric !== "price" && quantityFor(product)?.unit !== metric ? "quantité non comparable" : "aucun prix"}</small>}</li>
    )}</ul>
    {metric !== "price" && products.some(product => quantityFor(product)?.unit !== metric) &&
      <p className="v2-catalogue-source">Les produits sans quantité compatible avec {metricUnits[metric]} restent dans la liste, mais ne sont pas tracés.</p>}
    <p className="v2-catalogue-source">Historique : jusqu’à {detail.history_limit_per_product} points récents par produit. Les signalements Open Prices consécutifs au même prix sont résumés par le premier et le dernier jour de la période. Ces prix sont des relevés tiers, non vérifiés par Price Checker. Source : <a href="https://prices.openfoodfacts.org" target="_blank" rel="noreferrer">Open Prices / Open Food Facts</a> (ODbL).</p>
  </div>;
}
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
      const response = await fetch("/api/v2/catalogue/categories/" + encodeURIComponent(name) + "/classification", {
        method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ department: department.trim(), family: family.trim(), comparison_scope: scope.trim() || null,
          base_revision: current.classification_revision }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail || "Le classement n’a pas été enregistré.");
      }
      const updated = await response.json() as Classification;
      onSaved(updated);
      setSuccess("Classement enregistré pour tout le groupe comparable.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le classement n’a pas été enregistré."); }
    finally { setBusy(false); }
  }
  return <form className="v2-catalogue-classification" onSubmit={save}>
    <h2>Classement du groupe</h2>
    <p>Ce classement concerne tous les produits du groupe, sans modifier leur groupe comparable ni leurs prix.</p>
    {current.classification_source !== "manual" && <p>Valeurs préremplies à vérifier ; elles peuvent être corrigées ici.</p>}
    <fieldset disabled={busy}>
      <label>Rayon <input required maxLength={80} value={department} onChange={event => setDepartment(event.target.value)} /></label>
      <label>Famille <input required maxLength={80} value={family} onChange={event => setFamily(event.target.value)} /></label>
      <label>Ensemble de comparaison (facultatif)
        <input maxLength={80} list="v2-comparison-scope-options" value={scope} onChange={event => setScope(event.target.value)}
          placeholder="Ex. Jus d’orange" />
        <datalist id="v2-comparison-scope-options">{scopeOptions.map(value => <option key={value} value={value} />)}</datalist>
        <small>Les groupes du même rayon et de la même famille portant ce nom seront comparés ensemble. Laissez vide pour afficher le groupe directement.</small>
      </label>
      <button className="v2-button v2-button-secondary" type="submit">Enregistrer le classement</button>
    </fieldset>
    {error && <p role="alert">{error}</p>}{success && <p role="status">{success}</p>}
  </form>;
}

function ComparisonContent({ detail, showGroup = false }: { detail: PriceDetail; showGroup?: boolean }) {
  const [params, setParams] = useSearchParams();
  const page = pageNumber(params), size = pageSize(params);
  const subset = params.get("subset") || "";
  const products = detail.products;
  const selectedProducts = products.filter(product => matchesSubset(product, subset));
  const availableMetrics = unitMetrics.map(unit => ({
    unit, count: selectedProducts.filter(product => quantityFor(product)?.unit === unit).length,
  })).filter(item => item.count > 0).sort((a, b) => b.count - a.count);
  const requestedMetric = params.get("metric");
  const metric: ChartMetric = requestedMetric === "price" || availableMetrics.some(item => item.unit === requestedMetric)
    ? requestedMetric as ChartMetric : availableMetrics[0]?.unit || "price";
  function changePage(nextPage: number, nextSize: number) {
    const next = new URLSearchParams(params);
    next.set("page", String(nextPage));
    next.set("size", String(nextSize));
    setParams(next);
  }
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
      <label htmlFor="category-subset">Produits à garder
        <input id="category-subset" type="search" value={subset} onChange={event => changeSubset(event.target.value)}
          placeholder="Ex. sans pulpe" />
        <small>Filtre le nom, le nom commercial et les mots-clés des produits.</small>
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
      {!navigator.onLine && <p>Hors ligne : les relevés de prix ne sont pas conservés dans ce catalogue local.</p>}
      <CategoryChart detail={detail} products={selectedProducts} metric={metric} showGroup={showGroup} />
      <h2>Produits</h2>
      <div className="v2-workspace-list">{selectedProducts.slice((page - 1) * size, page * size).map(product =>
        <ProductLink key={product.id} product={product} showGroup={showGroup} />)}</div>
      <Pagination total={selectedProducts.length} page={page} size={size} onChange={changePage} />
    </> : <p>Aucun produit ne correspond à ce filtre.</p>}
  </>;
}

function CategoryPage({ name, user, onLogout }: Props & { name: string }) {
  const basket = useV2Basket();
  const basketGroup: BasketGroup = { kind: "group", name };
  const { data, error } = useCatalogue<CategoryDetail>("/categories/" + encodeURIComponent(name));
  const [savedClassification, setSavedClassification] = useState<Classification | null>(null);
  const classification = savedClassification ?? data;
  const products = data?.products ?? [];
  return <Frame user={user} onLogout={onLogout}>
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
      {data && <button type="button" className="v2-button v2-button-primary" onClick={() => basket.has(basketGroup) ? basket.remove(basketGroup) : basket.add(basketGroup)}>{basket.has(basketGroup) ? "Retirer ce groupe du panier" : "Ajouter ce groupe au panier"}</button>}</div>
    {error ? <p role="alert">{error}</p> : !data ? <p>Chargement…</p> : <>
      {user?.role === "admin" && classification && <ClassificationEditor key={name} name={name} current={classification} onSaved={setSavedClassification} />}
      <ComparisonContent detail={data} />
    </>}
  </Frame>;
}

function ScopePage({ department, family, scope, user, onLogout }: Props & { department: string; family: string; scope: string }) {
  const basket = useV2Basket();
  const basketScope: BasketScope = { kind: "scope", name: scope, department, family };
  const query = new URLSearchParams({ department, family, scope });
  const { data, error } = useCatalogue<ScopeDetail>("/comparison?" + query.toString());
  return <Frame user={user} onLogout={onLogout}>
    <nav className="v2-catalogue-crumbs" aria-label="Fil d’Ariane">
      <Link to="/v2/produits"><LevelBadge level="department" /> Rayons</Link>
      <Link to={browsePath(department)}><LevelBadge level="department" /> {department}</Link>
      <Link to={browsePath(department, family)}><LevelBadge level="family" /> {family}</Link>
    </nav>
    <div className="v2-workspace-heading"><div><LevelBadge level="scope" />
      <div className="v2-share-title-row"><h1>{scope}<span>.</span></h1>
      {data && <V2ShareButton title={"Ensemble · " + scope} url={window.location.origin + browsePath(department, family, scope)} />}</div><p>Comparez les prix de tous les groupes de cet ensemble, ou ouvrez un groupe précis.</p></div>
      {data && <button type="button" className="v2-button v2-button-primary" onClick={() => basket.has(basketScope) ? basket.remove(basketScope) : basket.add(basketScope)}>{basket.has(basketScope) ? "Retirer cet ensemble du panier" : "Ajouter cet ensemble au panier"}</button>}</div>
    {error ? <p role="alert">{error}</p> : !data ? <p>Chargement…</p> : <>
      <h2>Groupes comparables inclus</h2>
      <div className="v2-workspace-list">{data.groups.map(group =>
        <Link key={group.name} className="v2-workspace-list-item" to={"/v2/categories/" + encodeURIComponent(group.name)}>
          <div><LevelBadge level="group" /><strong>{group.name}</strong><small>{group.product_count} produit{group.product_count > 1 ? "s" : ""}</small></div>
          <span>Comparer ce groupe →</span>
        </Link>)}</div>
      <ComparisonContent detail={data} showGroup />
    </>}
  </Frame>;
}

function CatalogueIndex({ user, onLogout }: Props) {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "", category = params.get("category") || "";
  const department = params.get("rayon") || "", family = params.get("famille") || "";
  const storeId = Number(params.get("store") || 0), storeLabel = params.get("store_label") || "";
  const page = pageNumber(params), size = pageSize(params), searching = Boolean(q || category || storeId);
  const [queryDraft, setQueryDraft] = useState(q), [categoryDraft, setCategoryDraft] = useState(category);
  const [storeDraft, setStoreDraft] = useState(storeLabel), [selectedStore, setSelectedStore] = useState(storeId);
  const [stores, setStores] = useState<Store[]>([]);
  const [filterError, setFilterError] = useState("");
  const categories = useCatalogue<Category[]>("/categories");
  const searchParams = new URLSearchParams({ q, category, limit: String(size), offset: String((page - 1) * size) });
  if (storeId) searchParams.set("store_id", String(storeId));
  const search = useCatalogue<SearchResult>("/search?" + searchParams.toString(), searching);
  useEffect(() => {
    if (storeDraft.trim().length < 2 || selectedStore) return;
    let active = true;
    catalogueRequest<Store[]>("/stores?q=" + encodeURIComponent(storeDraft.trim()))
      .then(value => { if (active) setStores(value); }).catch(() => { if (active) setStores([]); });
    return () => { active = false; };
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
  function changePage(nextPage: number, nextSize: number) {
    const next = new URLSearchParams(params);
    next.set("page", String(nextPage)); next.set("size", String(nextSize)); setParams(next);
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
  return <Frame user={user} onLogout={onLogout}>
    <div className="v2-workspace-heading"><div><span className="v2-section-kicker">CATALOGUE V2</span><h1>Produits<span>.</span></h1>
      <p>Parcourez les rayons, familles, ensembles facultatifs et groupes comparables, ou recherchez une référence.</p></div>
      <Link className="v2-button v2-button-primary" to="/v2/produits/nouveau">Ajouter un produit →</Link>
    </div>
    <form className="v2-catalogue-search" onSubmit={apply}>
      <label htmlFor="catalogue-query">Rechercher un produit</label>
      <div className="v2-catalogue-search-row"><input id="catalogue-query" value={queryDraft} onChange={event => setQueryDraft(event.target.value)}
        placeholder="Nom, marque ou code-barres" /><button className="v2-button v2-button-primary" type="submit">Rechercher</button></div>
      <details className="v2-catalogue-filters" open={Boolean(category || storeId) || undefined}><summary>Filtres {category || storeId ? "· actifs" : "· groupe et magasin"}</summary>
        <div className="v2-catalogue-filter-fields">
          <label>Groupe comparable <select value={categoryDraft} onChange={event => setCategoryDraft(event.target.value)}>
            <option value="">Tous les groupes</option>{categoryList.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select></label>
          <div className="v2-catalogue-store"><label htmlFor="catalogue-store">Magasin</label>
            <input id="catalogue-store" value={storeDraft} autoComplete="off" placeholder="Nom ou ville (2 caractères min.)"
              onChange={event => { setStoreDraft(event.target.value); setSelectedStore(0); setStores([]); }} />
            {stores.length > 0 && <div className="v2-catalogue-suggestions">{stores.map(store => <button key={store.id} type="button"
              onClick={() => { setSelectedStore(store.id); setStoreDraft([store.retailer, store.name, store.city].filter(Boolean).join(" · ")); setStores([]); }}>
              {[store.retailer, store.name, store.city].filter(Boolean).join(" · ")}</button>)}</div>}
            {selectedStore > 0 && <small>Magasin sélectionné. Effacez le champ pour changer.</small>}
          </div>
        </div>
        <button type="submit" className="v2-button v2-button-secondary">Appliquer les filtres</button>
      </details>
      {filterError && <p role="alert">{filterError}</p>}
    </form>
    <details className="v2-catalogue-scan"><summary>Scanner un code-barres</summary><V2BarcodeSearch /></details>
    {searching ? <>
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
              <span>{item.kind === "scope" ? "Comparer tout l’ensemble →" : "Comparer ce groupe →"}</span>
            </Link>)}</div>
          <Pagination total={familyEntries.length} page={page} size={size} onChange={changePage} />
        </> : <p>Aucun groupe dans cette famille.</p>}
    </>}
  </Frame>;
}
export default function V2CataloguePage(props: Props) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const department = params.get("rayon") || "", family = params.get("famille") || "", scope = params.get("ensemble") || "";
  return props.name ? <CategoryPage key={props.name} {...props} name={props.name} />
    : department && family && scope ? <ScopePage {...props} department={department} family={family} scope={scope} />
    : <CatalogueIndex key={location.search} {...props} />;
}
