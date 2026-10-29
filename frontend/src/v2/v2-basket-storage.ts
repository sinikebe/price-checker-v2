import type { Product } from "./v2-products-api";

export const V2_BASKET_EVENT = "v2-basket-updated";
const ACTIVE_USER_KEY = "v2:basket:active-user";
const ANON_KEY = "v2:basket:anonymous";
export type BasketProduct = Pick<Product, "id" | "data" | "revision">;
export type BasketGroup = { kind: "group"; name: string };
export type BasketScope = { kind: "scope"; name: string; department: string; family: string };
export type BasketItem = BasketProduct | BasketGroup | BasketScope;
export function isBasketProduct(item: BasketItem): item is BasketProduct { return !("kind" in item); }
export const basketItemKey = (item: BasketItem): string => "kind" in item
  ? item.kind === "group" ? "group:" + item.name.toLocaleLowerCase("fr")
    : ["scope", item.department, item.family, item.name].map(part => part.toLocaleLowerCase("fr")).join(":")
  : "product:" + item.id;

export function activeBasketUser(): number | null {
  try { const value = Number(localStorage.getItem(ACTIVE_USER_KEY)); return value > 0 ? value : null; } catch { return null; }
}
export function basketKey(userId: number | null = activeBasketUser()) {
  return userId ? `v2:basket:user:${userId}` : ANON_KEY;
}
export function readV2Basket(userId: number | null = activeBasketUser()): BasketItem[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(basketKey(userId)) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is BasketItem => {
      if (!item || typeof item !== "object") return false;
      if ("kind" in item) return item.kind === "group" && typeof item.name === "string" && !!item.name.trim()
        || item.kind === "scope" && typeof item.name === "string" && !!item.name.trim()
          && typeof item.department === "string" && !!item.department.trim()
          && typeof item.family === "string" && !!item.family.trim();
      return "id" in item && typeof item.id === "number" && "data" in item && !!item.data
        && typeof item.data === "object" && "name" in item.data && typeof item.data.name === "string"
        && "revision" in item && typeof item.revision === "number";
    }) : [];
  } catch { return []; }
}
export function writeV2Basket(items: BasketItem[], userId: number | null = activeBasketUser()) {
  localStorage.setItem(basketKey(userId), JSON.stringify(items));
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
      const newItems = anonymous.filter(item => !existing.some(saved => basketItemKey(saved) === basketItemKey(item)));
      writeV2Basket([...existing, ...newItems], userId);
      localStorage.removeItem(ANON_KEY);
    }
    localStorage.setItem(ACTIVE_USER_KEY, String(userId));
  } else localStorage.removeItem(ACTIVE_USER_KEY);
  window.dispatchEvent(new Event(V2_BASKET_EVENT));
}
