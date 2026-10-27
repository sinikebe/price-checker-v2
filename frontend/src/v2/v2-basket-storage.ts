import type { Product } from "./v2-products-api";

export const V2_BASKET_EVENT = "v2-basket-updated";
const ACTIVE_USER_KEY = "v2:basket:active-user";
const ANON_KEY = "v2:basket:anonymous";
export type BasketProduct = Pick<Product, "id" | "data" | "revision">;

export function activeBasketUser(): number | null {
  try { const value = Number(localStorage.getItem(ACTIVE_USER_KEY)); return value > 0 ? value : null; } catch { return null; }
}
export function basketKey(userId: number | null = activeBasketUser()) {
  return userId ? `v2:basket:user:${userId}` : ANON_KEY;
}
export function readV2Basket(userId: number | null = activeBasketUser()): BasketProduct[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(basketKey(userId)) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is BasketProduct =>
      !!item && typeof item.id === "number" && item.data && typeof item.data.name === "string" && typeof item.revision === "number") : [];
  } catch { return []; }
}
export function writeV2Basket(products: BasketProduct[], userId: number | null = activeBasketUser()) {
  localStorage.setItem(basketKey(userId), JSON.stringify(products));
  window.dispatchEvent(new Event(V2_BASKET_EVENT));
}
export function activateBasketUser(userId: number | null, preserveOffline = false) {
  if (preserveOffline) return;
  const previous = activeBasketUser();
  if (previous === userId) return;
  if (userId) {
    const anonymous = readV2Basket(null);
    if (anonymous.length) {
      const existing = readV2Basket(userId);
      const newItems = anonymous.filter(item => !existing.some(saved => saved.id === item.id));
      writeV2Basket([...existing, ...newItems], userId);
      localStorage.removeItem(ANON_KEY);
    }
    localStorage.setItem(ACTIVE_USER_KEY, String(userId));
  } else localStorage.removeItem(ACTIVE_USER_KEY);
  window.dispatchEvent(new Event(V2_BASKET_EVENT));
}
