import type { Product } from "./v2-products-api";

// A recipe keeps its original reference. Resolve replacements only when using
// it in a basket, where prices and package sizes must belong to a current SKU.
export async function currentRecipeProduct(
  id: number, available: Product[], fetchProduct: (id: number) => Promise<Product>,
): Promise<Product | null> {
  const byId = new Map(available.map(product => [product.id, product]));
  const visited = new Set<number>();
  let current = id;
  for (let hop = 0; hop < 32; hop += 1) {
    const listed = byId.get(current);
    if (listed) return listed;
    if (visited.has(current)) return null;
    visited.add(current);
    let detail: Product;
    try { detail = await fetchProduct(current); } catch { return null; }
    const next = detail.merged_to_id ?? detail.successor_id;
    if (!next || next === current) return null;
    current = next;
  }
  return null;
}
