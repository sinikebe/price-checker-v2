import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { V2_BASKET_EVENT, activateBasketUser, basketItemKey, readV2Basket, writeV2Basket, type BasketItem } from "./v2-basket-storage";

type BasketValue = {
  items: BasketItem[];
  add: (item: BasketItem) => void;
  remove: (item: BasketItem | number) => void;
  setEnabled: (item: BasketItem, enabled: boolean) => void;
  replace: (item: BasketItem, next: BasketItem) => void;
  has: (item: BasketItem | number) => boolean;
  clear: () => void;
  setUser: (userId: number | null, preserveOffline?: boolean) => void;
};
const Context = createContext<BasketValue | null>(null);

export function V2BasketProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState(readV2Basket);
  useEffect(() => {
    const refresh = () => setItems(readV2Basket());
    window.addEventListener("storage", refresh);
    window.addEventListener(V2_BASKET_EVENT, refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener(V2_BASKET_EVENT, refresh); };
  }, []);
  const update = (next: BasketItem[]) => { setItems(next); try { writeV2Basket(next); } catch { /* current tab still works */ } };
  return <Context.Provider value={{
    items,
    add: item => { if (!items.some(saved => basketItemKey(saved) === basketItemKey(item))) update([...items, item]); },
    remove: item => { const key = typeof item === "number" ? "product:" + item : basketItemKey(item);
      update(items.filter(saved => basketItemKey(saved) !== key)); },
    setEnabled: (item, enabled) => { const key = basketItemKey(item);
      update(items.map(saved => basketItemKey(saved) === key ? { ...saved, disabled: !enabled } : saved)); },
    replace: (item, next) => { const key = basketItemKey(item), nextKey = basketItemKey(next);
      if (key !== nextKey && items.some(saved => basketItemKey(saved) === nextKey)) return;
      update(items.map(saved => basketItemKey(saved) === key
        ? { ...next, disabled: saved.disabled } : saved)); },
    has: item => { const key = typeof item === "number" ? "product:" + item : basketItemKey(item);
      return items.some(saved => basketItemKey(saved) === key); },
    clear: () => { update([]); },
    setUser: activateBasketUser,
  }}>{children}</Context.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useV2Basket() {
  const value = useContext(Context);
  if (!value) throw new Error("useV2Basket needs V2BasketProvider");
  return value;
}
