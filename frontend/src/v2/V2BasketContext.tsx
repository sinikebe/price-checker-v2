import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { V2_BASKET_EVENT, activateBasketUser, activeBasketUser, basketItemKey, isBasketProduct, readV2Basket, writeV2Basket, type BasketItem } from "./v2-basket-storage";
import { addedProductIds, requestBasketConnectorRefresh } from "./v2-connector-refresh";
import { combineQuantities } from "./v2-basket-quantity";
import type { BasketQuantity } from "./v2-basket-storage";
import { useSharedBasket, type SharedBasketControls } from "./useSharedBasket";

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
  /** The shared basket open in this browser, if any: while it is, every change above goes to it. */
  shared: SharedBasketControls;
};
const Context = createContext<BasketValue | null>(null);

export function V2BasketProvider({ children }: { children: ReactNode }) {
  const [local, setLocal] = useState(readV2Basket);
  const [userId, setUserId] = useState(activeBasketUser);
  const shared = useSharedBasket(userId);
  const sharing = shared.sharedId !== null;
  const items = sharing ? shared.items : local;
  const localRef = useRef(local);
  useEffect(() => { localRef.current = local; }, [local]);
  useEffect(() => {
    const refresh = () => { setLocal(readV2Basket()); setUserId(activeBasketUser()); };
    window.addEventListener("storage", refresh);
    window.addEventListener(V2_BASKET_EVENT, refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener(V2_BASKET_EVENT, refresh); };
  }, []);
  /** The basket being edited right now, the shared one included, unconfirmed changes applied. */
  const current = () => sharing ? shared.view() : localRef.current;
  const update = (next: BasketItem[]) => {
    const previous = new Set(current().filter(isBasketProduct).map(item => item.id));
    if (sharing) shared.edit(next);
    else {
      localRef.current = next; setLocal(next);
      try { writeV2Basket(next); } catch { /* current tab still works */ }
    }
    const added = addedProductIds(previous, next);
    if (added.length) void requestBasketConnectorRefresh(added);
  };
  return <Context.Provider value={{
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
    setUser: activateBasketUser,
    shared,
  }}>{children}</Context.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useV2Basket() {
  const value = useContext(Context);
  if (!value) throw new Error("useV2Basket needs V2BasketProvider");
  return value;
}
