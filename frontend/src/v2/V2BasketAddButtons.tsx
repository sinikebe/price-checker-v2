import { useV2Basket } from "./V2BasketContext";
import type { BasketItem } from "./v2-basket-storage";

const WHAT = { product: "", group: "ce groupe ", scope: "cet ensemble " } as const;

/** Add to (or remove from) the personal basket, and the shared basket when the account follows one. */
export default function V2BasketAddButtons({ item, what }: { item: BasketItem; what: keyof typeof WHAT }) {
  const basket = useV2Basket();
  const shared = basket.sharedBasket;
  const name = basket.shared.basket?.name;
  const label = WHAT[what];
  return <>
    <button type="button" className="v2-button v2-button-primary" onClick={() => basket.has(item) ? basket.remove(item) : basket.add(item)}>
      {basket.has(item) ? `Retirer ${label}du panier` : `Ajouter ${label}au panier`}</button>
    {shared && <button type="button" className="v2-button v2-button-secondary" title={name ? `Panier partagé « ${name} »` : "Panier partagé"}
      onClick={() => shared.has(item) ? shared.remove(item) : shared.add(item)}>
      {shared.has(item) ? `Retirer ${label}du panier partagé` : `Ajouter ${label}au panier partagé`}</button>}
  </>;
}
