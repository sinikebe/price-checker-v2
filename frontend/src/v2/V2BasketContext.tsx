import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { V2_BASKET_EVENT, activateBasketUser, basketItemKey, readV2Basket, writeV2Basket, type BasketItem } from "./v2-basket-storage";
import { combineQuantities } from "./v2-basket-quantity";
import type { BasketQuantity } from "./v2-basket-storage";

type BasketValue = {
  items: BasketItem[];
  add: (item: BasketItem) => void;
  remove: (item: BasketItem | number) => void;
  setEnabled: (item: BasketItem, enabled: boolean) => void;
  setQuantity: (item: BasketItem, quantity: BasketQuantity | undefined) => void;
  addQuantities: (entries: { item: BasketItem; quantity: BasketQuantity }[]) => { added: number; merged: number; conflicts: number };
  replace: (item: BasketItem, next: BasketItem) => void;
  has: (item: BasketItem | number) => boolean;
  clear: () => void;
  replaceAll: (incoming: BasketItem[]) => void;
  merge: (incoming: BasketItem[]) => number;
  setUser: (userId: number | null, preserveOffline?: boolean) => void;
};
const Context = createContext<BasketValue | null>(null);

export function V2BasketProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState(readV2Basket);
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => {
    const refresh = () => setItems(readV2Basket());
    window.addEventListener("storage", refresh);
    window.addEventListener(V2_BASKET_EVENT, refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener(V2_BASKET_EVENT, refresh); };
  }, []);
  const update = (next: BasketItem[]) => { itemsRef.current = next; setItems(next); try { writeV2Basket(next); } catch { /* current tab still works */ } };
  return <Context.Provider value={{
    items,
    add: item => { if (!items.some(saved => basketItemKey(saved) === basketItemKey(item))) update([...items, item]); },
    remove: item => { const key = typeof item === "number" ? "product:" + item : basketItemKey(item);
      update(items.filter(saved => basketItemKey(saved) !== key)); },
    setEnabled: (item, enabled) => { const key = basketItemKey(item);
      update(items.map(saved => basketItemKey(saved) === key ? { ...saved, disabled: !enabled } : saved)); },
    setQuantity: (item, quantity) => { const key = basketItemKey(item);
      update(itemsRef.current.map(saved => basketItemKey(saved) === key ? { ...saved, quantity } : saved)); },
    addQuantities: entries => {
      const next = [...itemsRef.current];
      let added = 0, merged = 0, conflicts = 0;
      for (const entry of entries) {
        const index = next.findIndex(saved => basketItemKey(saved) === basketItemKey(entry.item));
        if (index < 0) { next.push({ ...entry.item, quantity: entry.quantity }); added++; continue; }
        const quantity = combineQuantities(next[index].quantity, entry.quantity);
        if (!quantity) { conflicts++; continue; }
        next[index] = { ...next[index], quantity, disabled: false }; merged++;
      }
      if (conflicts) return { added: 0, merged: 0, conflicts };
      if (added || merged) update(next);
      return { added, merged, conflicts };
    },
    replace: (item, next) => { const key = basketItemKey(item), nextKey = basketItemKey(next);
      if (key !== nextKey && items.some(saved => basketItemKey(saved) === nextKey)) return;
      update(items.map(saved => basketItemKey(saved) === key
        ? { ...next, disabled: saved.disabled, quantity: saved.quantity } : saved)); },
    has: item => { const key = typeof item === "number" ? "product:" + item : basketItemKey(item);
      return items.some(saved => basketItemKey(saved) === key); },
    clear: () => { update([]); },
    replaceAll: incoming => update(incoming),
    merge: incoming => {
      const current = itemsRef.current;
      const keys = new Set(current.map(basketItemKey));
      const additions = incoming.filter(item => {
        const key = basketItemKey(item);
        if (keys.has(key)) return false;
        keys.add(key);
        return true;
      });
      if (additions.length) update([...current, ...additions]);
      return additions.length;
    },
    setUser: activateBasketUser,
  }}>{children}</Context.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useV2Basket() {
  const value = useContext(Context);
  if (!value) throw new Error("useV2Basket needs V2BasketProvider");
  return value;
}
