import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import { Frame } from "./V2ProductWorkspace";
import V2BarcodeSearch from "./V2BarcodeSearch";
import { productRequest, type Product } from "./v2-products-api";
import "./v2-catalogue.css";

type Category = { name: string; product_count: number };
type Store = { id: number; retailer: string; name: string; city: string | null; postal_code: string | null };
type SearchResult = { items: Product[]; total: number; limit: number; offset: number };
type Observation = { id: number; product_id: number; price: string; observed_at: string; retailer: string; store_name: string; city: string | null };
type CategoryDetail = { name: string; products: Product[]; observations: Observation[]; history_limit_per_product: number };
type Props = { name?: string; user: V2User | null; onLogout: () => Promise<void> };
const pageSizes = [10, 20, 50];
const colors = ["#3068aa", "#d9653b", "#229b82", "#865ac2", "#c2467e", "#af8129", "#516293", "#277482"];

function productName(product: Product): string {
  return [product.data.brand, product.data.name || "Produit sans nom"].filter(Boolean).join(" ");
}
async function offlineCatalogue(path: string): Promise<unknown> {
  const products = await productRequest<Product[]>("");
  const group = (item: Product) => item.data.group?.trim() || "Sans groupe";
  if (path === "/categories") {
    const counts = new Map<string, Category>();
    for (const product of products) {
      const name = group(product), key = name.toLocaleLowerCase("fr");
      const entry = counts.get(key);
      if (entry) entry.product_count++;
      else counts.set(key, { name, product_count: 1 });
    }
    return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }
  if (path.startsWith("/categories/")) {
    const name = decodeURIComponent(path.slice("/categories/".length));
    const matches = products.filter(product => group(product).toLocaleLowerCase("fr") === name.toLocaleLowerCase("fr"));
    if (!matches.length) throw new Error("Catégorie introuvable dans le catalogue local.");
    return { name, products: matches, observations: [], history_limit_per_product: 30 };
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
  return response.json() as Promise<T>;
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
function ProductLink({ product }: { product: Product }) {
  return <Link className="v2-workspace-list-item" to={"/v2/produits/" + product.id}>
    <div><strong>{productName(product)}</strong><small>{product.data.quantity || "Quantité à préciser"}</small></div>
    <span>Voir la fiche →</span>
  </Link>;
}
function CategoryChart({ detail }: { detail: CategoryDetail }) {
  const points = detail.observations.map(item => ({ ...item, time: Date.parse(item.observed_at), amount: Number(item.price) }))
    .filter(item => Number.isFinite(item.time) && Number.isFinite(item.amount));
  if (!points.length) return <p>Aucun prix connu pour les produits de cette catégorie.</p>;
  const width = 760, height = 280, left = 48, right = 20, top = 18, bottom = 38;
  const times = points.map(point => point.time), amounts = points.map(point => point.amount);
  const minTime = Math.min(...times), maxTime = Math.max(...times);
  const maxPrice = Math.max(1, ...amounts) * 1.1;
  const x = (time: number) => left + (time - minTime) / (maxTime - minTime || 1) * (width - left - right);
  const y = (amount: number) => height - bottom - amount / maxPrice * (height - top - bottom);
  const dateLabel = (time: number) => new Date(time).toLocaleDateString("fr-FR");
  return <div className="v2-catalogue-chart">
    <div className="v2-catalogue-chart-scroll"><svg role="img" aria-label={"Évolution des prix de " + detail.name} viewBox={"0 0 " + width + " " + height}>
      <line x1={left} y1={top} x2={left} y2={height - bottom} stroke="currentColor" />
      <line x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} stroke="currentColor" />
      <text x={left - 8} y={top + 4} textAnchor="end">{maxPrice.toFixed(2)} €</text>
      <text x={left - 8} y={height - bottom + 4} textAnchor="end">0 €</text>
      <text x={left} y={height - 9}>{dateLabel(minTime)}</text>
      <text x={width - right} y={height - 9} textAnchor="end">{dateLabel(maxTime)}</text>
      {detail.products.map((product, index) => {
        const series = points.filter(point => point.product_id === product.id).sort((a, b) => a.time - b.time);
        const color = colors[index % colors.length];
        return <g key={product.id}>
          {series.length > 1 && <polyline fill="none" stroke={color} strokeWidth="2.5"
            points={series.map(point => x(point.time) + "," + y(point.amount)).join(" ")} />}
          {series.map(point => <circle key={point.id} cx={x(point.time)} cy={y(point.amount)} r="4" fill={color}>
            <title>{productName(product) + " · " + dateLabel(point.time) + " · " + point.amount.toFixed(2) + " € · " + point.retailer}</title>
          </circle>)}
        </g>;
      })}
    </svg></div>
    <ul className="v2-catalogue-legend">{detail.products.map(product => {
      const index = detail.products.findIndex(item => item.id === product.id);
      return <li key={product.id}><span style={{ backgroundColor: colors[index % colors.length] }} /><Link to={"/v2/produits/" + product.id}>{productName(product)}</Link>{!points.some(point => point.product_id === product.id) && <small> · aucun prix</small>}</li>;
    })}</ul>
    <p className="v2-catalogue-source">Historique : jusqu’à {detail.history_limit_per_product} prix récents par produit. Les prix Open Prices sont des relevés tiers, non vérifiés par Price Checker. Source : <a href="https://prices.openfoodfacts.org" target="_blank" rel="noreferrer">Open Prices / Open Food Facts</a> (ODbL).</p>
  </div>;
}
function CategoryPage({ name, user, onLogout }: Props & { name: string }) {
  const [params, setParams] = useSearchParams();
  const page = pageNumber(params), size = pageSize(params);
  const { data, error } = useCatalogue<CategoryDetail>("/categories/" + encodeURIComponent(name));
  function changePage(nextPage: number, nextSize: number) {
    setParams({ page: String(nextPage), size: String(nextSize) });
  }
  const products = data?.products ?? [];
  return <Frame user={user} onLogout={onLogout}>
    <p><Link to="/v2/produits">← Toutes les catégories</Link></p>
    <div className="v2-workspace-heading"><div><span className="v2-section-kicker">CATÉGORIE</span>
      <h1>{data?.name || name}<span>.</span></h1><p>{products.length} produit{products.length > 1 ? "s" : ""} dans cette catégorie.</p></div></div>
    {error ? <p role="alert">{error}</p> : !data ? <p>Chargement…</p> : <>
      <h2>Prix de tous les produits</h2>{!navigator.onLine && <p>Hors ligne : les relevés de prix ne sont pas conservés dans ce catalogue local.</p>}<CategoryChart detail={data} />
      <h2>Produits</h2>
      <div className="v2-workspace-list">{products.slice((page - 1) * size, page * size).map(product => <ProductLink key={product.id} product={product} />)}</div>
      <Pagination total={products.length} page={page} size={size} onChange={changePage} />
    </>}
  </Frame>;
}
function CatalogueIndex({ user, onLogout }: Props) {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "", category = params.get("category") || "";
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
  const result = search.data;
  return <Frame user={user} onLogout={onLogout}>
    <div className="v2-workspace-heading"><div><span className="v2-section-kicker">CATALOGUE V2</span><h1>Produits<span>.</span></h1>
      <p>Parcourez les catégories ou affinez la recherche de références.</p></div>
      <Link className="v2-button v2-button-primary" to="/v2/produits/nouveau">Ajouter un produit →</Link>
    </div>
    <form className="v2-catalogue-search" onSubmit={apply}>
      <label htmlFor="catalogue-query">Rechercher un produit</label>
      <div className="v2-catalogue-search-row"><input id="catalogue-query" value={queryDraft} onChange={event => setQueryDraft(event.target.value)}
        placeholder="Nom, marque ou code-barres" /><button className="v2-button v2-button-primary" type="submit">Rechercher</button></div>
      <details className="v2-catalogue-filters" open={Boolean(category || storeId) || undefined}><summary>Filtres {category || storeId ? "· actifs" : "· catégorie et magasin"}</summary>
        <div className="v2-catalogue-filter-fields">
          <label>Catégorie <select value={categoryDraft} onChange={event => setCategoryDraft(event.target.value)}>
            <option value="">Toutes les catégories</option>{categoryList.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
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
      <h2>Catégories</h2>
      {categories.error ? <p role="alert">{categories.error}</p> : !categories.data ? <p>Chargement…</p>
        : !categoryList.length ? <p>Aucun produit publié.</p> : <>
          <div className="v2-workspace-list">{categoryList.slice((page - 1) * size, page * size).map(item =>
            <Link key={item.name} className="v2-workspace-list-item" to={"/v2/categories/" + encodeURIComponent(item.name)}>
              <div><strong>{item.name}</strong><small>{item.product_count} produit{item.product_count > 1 ? "s" : ""}</small></div>
              <span>Voir la catégorie →</span>
            </Link>)}</div>
          <Pagination total={categoryList.length} page={page} size={size} onChange={changePage} />
        </>}
    </>}
  </Frame>;
}
export default function V2CataloguePage(props: Props) {
  const location = useLocation();
  return props.name ? <CategoryPage {...props} name={props.name} /> : <CatalogueIndex key={location.search} {...props} />;
}
