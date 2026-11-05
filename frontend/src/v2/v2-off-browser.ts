/**
 * Open Food Facts, read by the visitor's browser when someone asks: Price Checker's server keeps none of
 * it. Open Food Facts asks for one request per real action, so these functions run on a click, never for
 * a list. Parsing is kept pure so that it can be unit-tested.
 */

const PRODUCT_API = "https://world.openfoodfacts.org/api/v2/product/";
const SEARCH_API = "https://world.openfoodfacts.org/cgi/search.pl";
export const OFF_PRODUCT_PAGE = "https://world.openfoodfacts.org/product/";
const PRODUCT_FIELDS = "code,product_name,brands,quantity,image_front_small_url,nutriscore_grade,nova_group,"
  + "ingredients_text_fr,ingredients_text,nutriments,last_modified_t";
const SEARCH_FIELDS = "code,product_name,brands,quantity,image_front_small_url";

/** What the product page shows from Open Food Facts. */
export type OffProduct = {
  code: string; name: string; brand: string; quantity: string; image: string | null;
  nutriscore: string; nova: string; ingredients: string; modifiedAt: string | null;
  /** Per 100 g or 100 ml, in display order, only the values Open Food Facts has. */
  nutrition: { label: string; value: number; unit: string }[];
};
/** A search result or a barcode match, for filling a new product's identifying facts. */
export type OffMatch = { code: string; name: string; brand: string; quantity: string; image: string | null };

export const validBarcode = (code: string) => /^(?:[0-9]{8}|[0-9]{12,14})$/.test(code);

const NUTRIENTS: [key: string, label: string, unit: string][] = [
  ["energy-kcal_100g", "Énergie", "kcal"], ["fat_100g", "Matières grasses", "g"], ["saturated-fat_100g", "dont acides gras saturés", "g"],
  ["carbohydrates_100g", "Glucides", "g"], ["sugars_100g", "dont sucres", "g"], ["fiber_100g", "Fibres", "g"],
  ["proteins_100g", "Protéines", "g"], ["salt_100g", "Sel", "g"],
];

const text = (value: unknown) => typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
/** Only images served by Open Food Facts itself, over HTTPS. */
export function offImage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "openfoodfacts.org" || url.hostname.endsWith(".openfoodfacts.org")) ? value : null;
  } catch { return null; }
}
const firstBrand = (value: unknown) => text(Array.isArray(value) ? value[0] : value).split(",")[0].trim();

function match(product: Record<string, unknown>): OffMatch | null {
  const code = text(product.code);
  if (!validBarcode(code)) return null;
  return { code, name: text(product.product_name), brand: firstBrand(product.brands), quantity: text(product.quantity), image: offImage(product.image_front_small_url) };
}

/** The product page's view of an Open Food Facts answer, or null when the product is unknown there. */
export function parseOffProduct(payload: unknown): OffProduct | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  if (body.status !== 1 || !body.product || typeof body.product !== "object") return null;
  const product = body.product as Record<string, unknown>;
  const base = match(product);
  if (!base) return null;
  const nutriments = product.nutriments && typeof product.nutriments === "object" ? product.nutriments as Record<string, unknown> : {};
  const grade = text(product.nutriscore_grade).toLowerCase();
  const nova = text(product.nova_group);
  const modified = typeof product.last_modified_t === "number" ? new Date(product.last_modified_t * 1000).toISOString() : null;
  return {
    ...base,
    nutriscore: /^[a-e]$/.test(grade) ? grade.toUpperCase() : "",
    nova: /^[1-4]$/.test(nova) ? nova : "",
    ingredients: text(product.ingredients_text_fr) || text(product.ingredients_text),
    modifiedAt: modified,
    nutrition: NUTRIENTS.flatMap(([key, label, unit]) => {
      const value = nutriments[key];
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? [{ label, value, unit }] : [];
    }),
  };
}

/** The products of an Open Food Facts search answer that have a usable barcode. */
export function parseOffSearch(payload: unknown): OffMatch[] {
  if (!payload || typeof payload !== "object") return [];
  const products = (payload as Record<string, unknown>).products;
  if (!Array.isArray(products)) return [];
  return products.flatMap(product => product && typeof product === "object" ? [match(product as Record<string, unknown>)].filter((item): item is OffMatch => item !== null) : []);
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { mode: "cors", credentials: "omit", cache: "no-store", signal });
  if (response.status === 404) return null;
  if (response.status === 429) throw new Error("Open Food Facts limite les consultations : réessayez dans une minute.");
  if (!response.ok) throw new Error("Open Food Facts ne répond pas pour le moment.");
  return response.json();
}

/** One product by barcode, read from this browser. */
export async function readOffProduct(barcode: string, signal?: AbortSignal): Promise<OffProduct | null> {
  if (!validBarcode(barcode)) return null;
  return parseOffProduct(await getJson(`${PRODUCT_API}${barcode}.json?fields=${PRODUCT_FIELDS}&lc=fr`, signal));
}

/** A text search (10 results), read from this browser. */
export async function searchOff(query: string, signal?: AbortSignal): Promise<OffMatch[]> {
  const terms = query.trim().slice(0, 100);
  if (terms.length < 2) return [];
  const params = new URLSearchParams({ search_terms: terms, search_simple: "1", action: "process", json: "1", page_size: "10", fields: SEARCH_FIELDS, lc: "fr" });
  return parseOffSearch(await getJson(`${SEARCH_API}?${params.toString()}`, signal));
}
