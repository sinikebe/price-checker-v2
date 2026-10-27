import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { V2_BASKET_EVENT, activateBasketUser, readV2Basket, writeV2Basket, type BasketProduct } from "./v2-basket-storage";

type BasketValue = {
  products: BasketProduct[];
  add: (product: BasketProduct) => void;
  remove: (id: number) => void;
  has: (id: number) => boolean;
  clear: () => void;
  setUser: (userId: number | null, preserveOffline?: boolean) => void;
};
const Context = createContext<BasketValue | null>(null);

export function V2BasketProvider({ children }: { children: ReactNode }) {
  const [products, setProducts] = useState(readV2Basket);
  useEffect(() => {
    const refresh = () => setProducts(readV2Basket());
    window.addEventListener("storage", refresh);
    window.addEventListener(V2_BASKET_EVENT, refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener(V2_BASKET_EVENT, refresh); };
  }, []);
  const update = (next: BasketProduct[]) => { setProducts(next); try { writeV2Basket(next); } catch { /* current tab still works */ } };
  return <Context.Provider value={{
    products,
    add: product => { if (!products.some(item => item.id === product.id)) { update([...products, product]); } },
    remove: id => { update(products.filter(item => item.id !== id)); },
    has: id => products.some(item => item.id === id),
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
