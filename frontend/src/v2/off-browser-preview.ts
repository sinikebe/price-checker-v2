/** Browser-only OFF read used when the server's shared quota is exhausted. */
export type OffBrowserPreview = {
  code: string; name: string; brand: string; quantity: string;
  ingredients: string; nutriscore: string; nova: string;
};

export async function readOffInBrowser(barcode: string): Promise<OffBrowserPreview | null> {
  if (!/^(?:[0-9]{8}|[0-9]{12,14})$/.test(barcode)) return null;
  const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=code,product_name,brands,quantity,ingredients_text,nutriscore_grade,nova_group`, {
    mode: "cors", credentials: "omit", cache: "no-store",
  });
  if (!response.ok) throw new Error("Lecture directe d’Open Food Facts indisponible.");
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("status" in payload) || payload.status !== 1 ||
      !("product" in payload) || !payload.product || typeof payload.product !== "object") return null;
  const product = payload.product as Record<string, unknown>;
  const value = (key: string) => typeof product[key] === "string" ? product[key] as string : "";
  const rawBrands = product.brands;
  const brand = typeof rawBrands === "string" ? rawBrands.split(",")[0].trim() :
    Array.isArray(rawBrands) ? String(rawBrands[0] ?? "").trim() : "";
  return {
    code: barcode, name: value("product_name"), brand,
    quantity: value("quantity"), ingredients: value("ingredients_text"),
    nutriscore: value("nutriscore_grade"),
    nova: typeof product.nova_group === "number" ? String(product.nova_group) : "",
  };
}
