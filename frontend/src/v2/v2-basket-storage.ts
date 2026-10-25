import type { Product } from "./v2-products-api";

export const V2_BASKET_EVENT = "v2-basket-updated";
export const V2_BASKET_LOCAL_CHANGE = "v2-basket-local-change";
const ACTIVE_USER_KEY = "v2:basket:active-user";
const ANON_KEY = "v2:basket:anonymous";
export type BasketProduct = Pick<Product, "id" | "data" | "revision">;
export type BasketOp = { type: "add" | "remove" | "clear"; id?: number };

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
export function basketOpsKey(userId: number) { return `v2:basket:ops:${userId}`; }
export function readBasketOps(userId: number): BasketOp[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(basketOpsKey(userId)) ?? "[]"); return Array.isArray(value) ? value as BasketOp[] : []; } catch { return []; }
}
export function appendBasketOp(op: BasketOp) {
  const userId = activeBasketUser();
  if (!userId) return;
  try { localStorage.setItem(basketOpsKey(userId), JSON.stringify([...readBasketOps(userId), op])); } catch { /* local basket remains */ }
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
      for (const item of newItems) {
        const ops = readBasketOps(userId);
        localStorage.setItem(basketOpsKey(userId), JSON.stringify([...ops, { type: "add", id: item.id }]));
      }
      localStorage.removeItem(ANON_KEY);
    }
    localStorage.setItem(ACTIVE_USER_KEY, String(userId));
  } else localStorage.removeItem(ACTIVE_USER_KEY);
  window.dispatchEvent(new Event(V2_BASKET_EVENT));
}
