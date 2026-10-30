import type { Product } from "./v2-products-api";

// Local baskets and recipes may keep an old reference. Follow replacement
// links before pricing it; a missing or withdrawn link fails closed.
export async function currentBasketProduct(
  id: number, available: Product[] | null, fetchProduct: (id: number) => Promise<Product>,
): Promise<Product | null> {
  const byId = new Map((available ?? []).map(product => [product.id, product]));
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
    if (!next) return available ? null : detail;
    if (next === current) return null;
    current = next;
  }
  return null;
}
