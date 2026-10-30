export const BASKET_DEFAULT_STORES_KEY = "v2:basket:default-stores";
export type BasketDefaultStore = { id: number; name: string };

export function readBasketDefaultStores(): BasketDefaultStore[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(BASKET_DEFAULT_STORES_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    const seen = new Set<number>();
    return value.filter((store): store is BasketDefaultStore => {
      if (!store || typeof store !== "object" || !("id" in store) || !("name" in store)) return false;
      if (typeof store.id !== "number" || !Number.isSafeInteger(store.id) || store.id <= 0 || typeof store.name !== "string"
        || !store.name.trim() || store.name.length > 160 || seen.has(store.id)) return false;
      seen.add(store.id);
      return true;
    }).slice(0, 200);
  } catch { return []; }
}

export function writeBasketDefaultStores(stores: BasketDefaultStore[]) {
  if (stores.length > 200) throw new Error("Trop de magasins sélectionnés");
  if (stores.length) localStorage.setItem(BASKET_DEFAULT_STORES_KEY, JSON.stringify(stores));
  else localStorage.removeItem(BASKET_DEFAULT_STORES_KEY);
}
