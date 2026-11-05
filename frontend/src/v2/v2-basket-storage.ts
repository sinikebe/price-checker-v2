import type { Product } from "./v2-products-api";

export const V2_BASKET_EVENT = "v2-basket-updated";
export type BasketQuantity = { amount: string; unit: "g" | "kg" | "ml" | "cl" | "l" | "piece" | "package" };
export function validBasketQuantity(value: unknown): value is BasketQuantity {
  if (!value || typeof value !== "object" || !("amount" in value) || !("unit" in value)) return false;
  const quantity = value as BasketQuantity;
  return typeof quantity.amount === "string" && /^\d{1,6}(?:\.\d{1,6})?$/.test(quantity.amount)
    && Number(quantity.amount) > 0 && ["g", "kg", "ml", "cl", "l", "piece", "package"].includes(quantity.unit);
}
const ACTIVE_USER_KEY = "v2:basket:active-user";
const ANON_KEY = "v2:basket:anonymous";
type BasketOptions = { disabled?: boolean; quantity?: BasketQuantity };
export type BasketProduct = Pick<Product, "id" | "data" | "revision" | "off_reference"> & BasketOptions;
export type BasketGroup = { kind: "group"; name: string } & BasketOptions;
export type BasketScope = { kind: "scope"; name: string; department: string; family: string } & BasketOptions;
/** Free text: an article not in the catalogue yet, kept for the list and replaced later by a product, group or ensemble. */
export type BasketText = { kind: "text"; name: string } & BasketOptions;
/** One part of a selection: exactly one level (a product id, or a group, ensemble, family or department name);
 * an ensemble or a family may add the levels above it to tell apart equal names. */
export type SelectionMember = { product?: number; group?: string; scope?: string; family?: string; department?: string };
/**
 * Several parts of the catalogue compared as one article ("any organic fruit juice"): the products of the
 * included members, minus the excluded ones, kept to those whose text holds every word. It lives in the
 * basket only. The server resolves it (POST /api/v2/basket/selection previews it).
 */
export type BasketSelection = {
  kind: "selection"; name: string; include: SelectionMember[]; exclude?: SelectionMember[]; words?: string[];
} & BasketOptions;
export type BasketItem = BasketProduct | BasketGroup | BasketScope | BasketText | BasketSelection;
export const SELECTION_MAX_MEMBERS = 20;
export const SELECTION_MAX_WORDS = 5;
const memberText = (value: unknown, max: number) => value === undefined || typeof value === "string" && !!value.trim() && value.length <= max;
export function validSelectionMember(value: unknown): value is SelectionMember {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const member = value as Record<string, unknown>;
  if (!memberText(member.group, 100) || !memberText(member.scope, 80) || !memberText(member.family, 80) || !memberText(member.department, 80)) return false;
  if (member.product !== undefined) return Number.isSafeInteger(member.product) && (member.product as number) > 0
    && member.group === undefined && member.scope === undefined && member.family === undefined && member.department === undefined;
  if (member.group !== undefined) return member.scope === undefined && member.family === undefined && member.department === undefined;
  return member.scope !== undefined || member.family !== undefined || member.department !== undefined;
}
export function validSelection(value: unknown): value is BasketSelection {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const list = (field: unknown, max: number) => field === undefined || Array.isArray(field) && field.length <= max;
  return item.kind === "selection" && typeof item.name === "string" && !!item.name.trim() && item.name.length <= 100
    && Array.isArray(item.include) && item.include.length > 0 && item.include.length <= SELECTION_MAX_MEMBERS && item.include.every(validSelectionMember)
    && list(item.exclude, SELECTION_MAX_MEMBERS) && ((item.exclude as unknown[] | undefined) ?? []).every(validSelectionMember)
    && list(item.words, SELECTION_MAX_WORDS)
    && ((item.words as unknown[] | undefined) ?? []).every(word => typeof word === "string" && !!word.trim() && word.length <= 40);
}
export function isBasketProduct(item: BasketItem): item is BasketProduct { return !("kind" in item); }
export function isFreeText(item: BasketItem): item is BasketText { return "kind" in item && item.kind === "text"; }
/** Whether an article has prices to compare: everything but free text. */
export const isPriceable = (item: BasketItem) => !isFreeText(item);
/** The longest free text line. */
export const FREE_TEXT_MAX = 100;
/** A basket line with fresher product data: its quantity and its excluded flag stay. */
export function withProductData(item: BasketProduct, product: Pick<Product, "data" | "revision" | "off_reference">): BasketProduct {
  if (!product.off_reference) {
    const { off_reference: _reference, ...rest } = item; void _reference;
    return { ...rest, data: product.data, revision: product.revision };
  }
  // Known only by its barcode: the server has no name, so the one this browser read from Open Food
  // Facts when the product was added stays (on this device only).
  const kept = { name: item.data.name, brand: item.data.brand, quantity: item.data.quantity };
  return { ...item, off_reference: true, revision: product.revision,
    data: { ...product.data, name: product.data.name || kept.name, brand: product.data.brand || kept.brand, quantity: product.data.quantity || kept.quantity } };
}
export const basketItemKey = (item: BasketItem): string => "kind" in item
  ? item.kind === "group" || item.kind === "text" || item.kind === "selection" ? item.kind + ":" + item.name.toLocaleLowerCase("fr")
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
      if ("kind" in item) return (item.kind === "group" || item.kind === "text") && typeof item.name === "string" && !!item.name.trim()
        || item.kind === "selection" && validSelection(item)
        || item.kind === "scope" && typeof item.name === "string" && !!item.name.trim()
          && typeof item.department === "string" && !!item.department.trim()
          && typeof item.family === "string" && !!item.family.trim();
      return "id" in item && typeof item.id === "number" && "data" in item && !!item.data
        && typeof item.data === "object" && "name" in item.data && typeof item.data.name === "string"
        && "revision" in item && typeof item.revision === "number";
    }).map(item => item.quantity === undefined ? item : validBasketQuantity(item.quantity)
      ? item : (() => { const { quantity: _quantity, ...rest } = item; void _quantity; return rest as BasketItem; })()) : [];
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
