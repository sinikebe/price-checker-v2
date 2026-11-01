import type { BasketGroup, BasketItem, BasketProduct, BasketScope } from "./v2-basket-storage";
import type { BasketPrice, CompareMode, StoreSaving, UnitInfo } from "./v2-basket-comparison";

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

const amount = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
/** "2,40 € / kg": the price per kilogram, litre or piece of a choice. */
export function unitPriceText(unit: UnitInfo): string {
  const scale = unit.unit === "piece" ? 1 : 1000;
  return `${money(unit.perUnitCents * scale)} / ${unit.unit === "g" ? "kg" : unit.unit === "ml" ? "L" : "pièce"}`;
}
/** What stays unused once the need is covered, or null when it is negligible. */
export function surplusText(unit: UnitInfo): string | null {
  const { surplus } = unit;
  if (unit.unit === "piece") return surplus >= 0.5 ? `Reste après vos besoins : ${amount.format(surplus)} pièce${surplus >= 1.5 ? "s" : ""}` : null;
  if (surplus < 1) return null;
  const big = surplus >= 1000;
  return `Reste après vos besoins : ${amount.format(big ? surplus / 1000 : surplus)} ${unit.unit === "g" ? (big ? "kg" : "g") : (big ? "L" : "ml")}`;
}

/**
 * What a store of the split brings, in words: the extra spending without it (the extra value of the needed
 * amounts, when comparing per unit), or why it cannot be compared. `totalCents` is the total on that basis.
 */
export function savingText(saving: StoreSaving, totalCents: number, singleStore: boolean, mode: CompareMode = "price"): { kind: "saving" | "none" | "only"; text: string } {
  if (saving.unpriced > 0) {
    const articles = singleStore ? "ce panier" : `${saving.unpriced} article${saving.unpriced > 1 ? "s" : ""}`;
    const rest = saving.extraCents > 0 ? ` · économie sur les autres articles : ${money(saving.extraCents)}` : "";
    return { kind: "only", text: `Seul magasin avec un prix pour ${articles}${rest}` };
  }
  if (saving.extraCents <= 0) return { kind: "none", text: mode === "unit" ? "Aucune économie : le même prix à l’unité existe ailleurs" : "Aucune économie : les mêmes prix existent ailleurs" };
  const percent = Math.max(1, Math.round(100 * saving.extraCents / (totalCents + saving.extraCents)));
  return { kind: "saving", text: mode === "unit"
    ? `Économie à l’unité : ${money(saving.extraCents)} sur la quantité utile (${percent} %)`
    : `Économie grâce à ce magasin : ${money(saving.extraCents)} (${percent} %)` };
}
