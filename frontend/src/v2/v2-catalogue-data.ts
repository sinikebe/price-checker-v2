import { suggestRequest, type SuggestResult } from "./v2-catalogue-api";
import { matchesQuery, type SearchScope } from "./v2-catalogue-search";
import { productRequest, type Product } from "./v2-products-api";

// The catalogue's data: the server's answers, or offline the same answers built from the product list
// kept by the service worker and the last classification read (rayons, familles, ensembles).

export type Classification = {
  department: string; family: string; comparison_scope: string | null; classification_source: string; classification_revision: number;
};
export type Category = Classification & { name: string; product_count: number };
export const UNCLASSIFIED = "À classer";
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
export type SearchResult = { items: Product[]; total: number; limit: number; offset: number };
async function offlineCatalogue(path: string): Promise<unknown> {
  // Refused before the whole local product list is read for nothing.
  if (path.startsWith("/search?") && new URLSearchParams(path.slice("/search?".length)).get("store_id"))
    throw new Error("Le filtre magasin nécessite une connexion.");
  if (path !== "/categories" && !path.startsWith("/categories/") && !path.startsWith("/comparison?") && !path.startsWith("/search?"))
    throw new Error("Cette recherche n’est pas disponible hors ligne.");
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
    const category = (params.get("category") || "").toLocaleLowerCase("fr");
    const matches = products.filter(product => (!category || group(product).toLocaleLowerCase("fr") === category)
      && matchesQuery(product, params.get("q") || ""));
    const limit = Number(params.get("limit") || 10), offset = Number(params.get("offset") || 0);
    return { items: matches.slice(offset, offset + limit), total: matches.length, limit, offset };
  }
  throw new Error("Cette recherche n’est pas disponible hors ligne.");
}
/** The most results the server lists in full, as last announced; used to decide the same way offline. */
let knownCompleteMax = 50;
export async function suggest(query: string, scope: SearchScope, signal: AbortSignal): Promise<SuggestResult<Product>> {
  try {
    const result = await suggestRequest<Product>(query, scope, signal);
    knownCompleteMax = result.max;
    return result;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const filters = new URLSearchParams({ q: query, category: scope.category, limit: "1000", offset: "0" });
    if (scope.storeId) filters.set("store_id", String(scope.storeId));
    const local = await offlineCatalogue("/search?" + filters.toString()) as SearchResult;
    const complete = local.total <= knownCompleteMax;
    return { total: local.total, complete, max: knownCompleteMax, items: complete ? local.items : [] };
  }
}
export async function catalogueRequest<T>(path: string): Promise<T> {
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
