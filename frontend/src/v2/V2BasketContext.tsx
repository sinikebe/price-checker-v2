import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { V2_BASKET_EVENT, activeBasketUser, basketItemKey, isBasketProduct, readV2Basket, writeV2Basket, type BasketItem } from "./v2-basket-storage";
import { addedProductIds, requestBasketConnectorRefresh } from "./v2-connector-refresh";
import { combineQuantities } from "./v2-basket-quantity";
import type { BasketQuantity } from "./v2-basket-storage";
import { useSharedBasket, type SharedBasketControls } from "./useSharedBasket";

/** What can be done with one basket: the personal one, or the shared one. */
export type BasketApi = {
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
};
/** The personal basket (on this device) at the top level, as before; the shared one beside it. */
type BasketValue = BasketApi & {
  /** The shared basket followed in this browser: its live state, members and settings. */
  shared: SharedBasketControls;
  /** The same actions on the shared basket, or null when this account follows none. */
  sharedBasket: BasketApi | null;
};
const Context = createContext<BasketValue | null>(null);

/** The actions on one basket, from what it holds now (`current`) and how to change it (`write`). */
function basketApi(items: BasketItem[], current: () => BasketItem[], write: (next: BasketItem[]) => void): BasketApi {
  const update = (next: BasketItem[]) => {
    const previous = new Set(current().filter(isBasketProduct).map(item => item.id));
    write(next);
    const added = addedProductIds(previous, next);
    if (added.length) void requestBasketConnectorRefresh(added);
  };
  return {
    items,
    add: item => { const now = current(); if (!now.some(saved => basketItemKey(saved) === basketItemKey(item))) update([...now, item]); },
    remove: item => { const key = typeof item === "number" ? "product:" + item : basketItemKey(item);
      update(current().filter(saved => basketItemKey(saved) !== key)); },
    setEnabled: (item, enabled) => { const key = basketItemKey(item);
      update(current().map(saved => basketItemKey(saved) === key ? { ...saved, disabled: !enabled } : saved)); },
    setQuantity: (item, quantity) => { const key = basketItemKey(item);
      update(current().map(saved => basketItemKey(saved) === key ? { ...saved, quantity } : saved)); },
    addQuantities: entries => {
      const next = [...current()];
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
    replace: (item, next) => { const now = current(), key = basketItemKey(item), nextKey = basketItemKey(next);
      if (key !== nextKey && now.some(saved => basketItemKey(saved) === nextKey)) return;
      update(now.map(saved => basketItemKey(saved) === key
        ? { ...next, disabled: saved.disabled, quantity: saved.quantity } : saved)); },
    has: item => { const key = typeof item === "number" ? "product:" + item : basketItemKey(item);
      return items.some(saved => basketItemKey(saved) === key); },
    clear: () => { update([]); },
    replaceAll: incoming => update(incoming),
    merge: incoming => {
      const now = current();
      const keys = new Set(now.map(basketItemKey));
      const additions = incoming.filter(item => {
        const key = basketItemKey(item);
        if (keys.has(key)) return false;
        keys.add(key);
        return true;
      });
      if (additions.length) update([...now, ...additions]);
      return additions.length;
    },
  };
}

export function V2BasketProvider({ children }: { children: ReactNode }) {
  const [local, setLocal] = useState(readV2Basket);
  const [userId, setUserId] = useState(activeBasketUser);
  const shared = useSharedBasket(userId);
  const localRef = useRef(local);
  useEffect(() => { localRef.current = local; }, [local]);
  useEffect(() => {
    const refresh = () => { setLocal(readV2Basket()); setUserId(activeBasketUser()); };
    window.addEventListener("storage", refresh);
    window.addEventListener(V2_BASKET_EVENT, refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener(V2_BASKET_EVENT, refresh); };
  }, []);
  const currentLocal = useCallback(() => localRef.current, []);
  const writeLocal = useCallback((next: BasketItem[]) => {
    localRef.current = next; setLocal(next);
    try { writeV2Basket(next); } catch { /* current tab still works */ }
  }, []);
  // The callbacks read the ref when an action runs (a click), never while rendering.
  // eslint-disable-next-line react-hooks/refs
  const personal = basketApi(local, currentLocal, writeLocal);
  const sharedBasket = shared.sharedId !== null ? basketApi(shared.items, shared.view, shared.edit) : null;
  return <Context.Provider value={{ ...personal, shared, sharedBasket }}>{children}</Context.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useV2Basket() {
  const value = useContext(Context);
  if (!value) throw new Error("useV2Basket needs V2BasketProvider");
  return value;
}
