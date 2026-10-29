import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { V2_BASKET_EVENT, activateBasketUser, basketItemKey, readV2Basket, writeV2Basket, type BasketItem } from "./v2-basket-storage";

type BasketValue = {
  items: BasketItem[];
  add: (item: BasketItem) => void;
  remove: (item: BasketItem | number) => void;
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
