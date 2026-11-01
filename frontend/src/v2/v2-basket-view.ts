import type { BasketGroup, BasketItem, BasketProduct, BasketScope } from "./v2-basket-storage";
import type { BasketPrice } from "./v2-basket-comparison";

export type Category = { name: string; department: string; family: string; comparison_scope: string | null };

const channelNames: Record<BasketPrice["sales_channel"], string> = {
  in_store: "En magasin", drive: "Drive", delivery: "Livraison",
};
const euros = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
export const money = (cents: number) => euros.format(cents / 100);
export const productName = (product: BasketProduct) => [product.data.brand, product.data.name].filter(Boolean).join(" ");
export const itemName = (item: BasketItem) => "kind" in item ? item.name : productName(item);
export const itemKind = (item: BasketItem) => "kind" in item ? item.kind === "group" ? "Groupe comparable" : "Ensemble" : "Produit";
const fold = (value: string) => value.toLocaleLowerCase("fr");

export function itemHref(item: BasketItem) {
  if (!("kind" in item)) return "/v2/produits/" + item.id;
  if (item.kind === "group") return "/v2/categories/" + encodeURIComponent(item.name);
  return "/v2/produits?" + new URLSearchParams({ rayon: item.department, famille: item.family, ensemble: item.name });
}

/** The other groups or ensembles an article may be compared as, when it belongs to a comparison scope. */
export function alternatives(item: BasketItem, categories: Category[]): (BasketGroup | BasketScope)[] {
  if (!("kind" in item)) return [];
  const group = item.kind === "group" ? categories.find(category => fold(category.name) === fold(item.name)) : null;
  if (item.kind === "group" && !group?.comparison_scope) return [];
  const location = item.kind === "scope" ? item : group!;
  const scope = item.kind === "scope" ? item.name : group!.comparison_scope!;
  const members = categories.filter(category => fold(category.department) === fold(location!.department)
    && fold(category.family) === fold(location!.family)
    && fold(category.comparison_scope ?? "") === fold(scope));
  if (!members.length) return [];
  return [
    { kind: "scope", name: scope, department: location!.department, family: location!.family },
    ...members.map(category => ({ kind: "group" as const, name: category.name })),
  ];
}

export const shortDate = (value: string) => new Date(value + "T12:00:00").toLocaleDateString("fr-FR", {
  day: "numeric", month: "short", year: "numeric",
});
export function fetchedLabel(value: string): string {
  const moment = new Date(value);
  return Number.isNaN(moment.getTime()) ? "" : moment.toLocaleString("fr-FR", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}
export function freshness(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const now = new Date();
  const age = Math.max(0, Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
    - Date.UTC(year, month - 1, day)) / 86400000));
  if (!Number.isFinite(age)) return { code: "old", label: "Date à vérifier" };
  if (age <= 30) return { code: "recent", label: "Récent" };
  if (age <= 90) return { code: "aging", label: "À vérifier" };
  return { code: "old", label: "Ancien" };
}
export function storeName(row: BasketPrice) {
  return [row.store_name, row.city, row.postal_code, channelNames[row.sales_channel]].filter(Boolean).join(" · ");
}
export const quantityText = (quantity: NonNullable<BasketItem["quantity"]>) =>
  quantity.amount + " " + (quantity.unit === "package" ? "paquet(s)" : quantity.unit === "piece" ? "pièce(s)" : quantity.unit);

/** Stores listed at first, and added by each "see more". */
export const FIRST_STORES = 2;
export const MORE_STORES = 5;
