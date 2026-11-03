import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import { useV2Basket } from "./V2BasketContext";
import { CartIcon, HomeIcon, ProductsIcon, RecipesIcon, SharedCartIcon, StoreIcon } from "./V2SiteIcons";
import { activeDockId, basketLabel, dockItems, sharedBasketLabel, type DockId } from "./v2-site-nav";
import "./v2-site-nav.css";

const ICONS: Record<DockId, () => React.JSX.Element> = {
  home: HomeIcon, products: ProductsIcon, stores: StoreIcon, recipes: RecipesIcon, basket: CartIcon, shared: SharedCartIcon,
};

/** Floating bottom bar with the main sections: icons only, and the name of the current one. */
export default function V2Dock() {
  const { pathname } = useLocation();
  const { items, sharedBasket } = useV2Basket();
  const active = activeDockId(pathname);
  useEffect(() => {
    document.body.classList.add("v2-has-dock");
    return () => document.body.classList.remove("v2-has-dock");
  }, []);
  // Rendered at the end of the page so that it comes last in the reading and tab order.
  return createPortal(
    <nav className="v2-dock" aria-label="Navigation principale">
      {dockItems(sharedBasket !== null).map(item => {
        const Icon = ICONS[item.id];
        const count = item.id === "basket" ? items.length : item.id === "shared" ? sharedBasket?.items.length ?? 0 : 0;
        return <Link key={item.id} className="v2-dock-item" to={item.to} title={item.id === "shared" ? "Panier partagé" : item.label}
          aria-label={item.id === "basket" ? basketLabel(count) : item.id === "shared" ? sharedBasketLabel(count) : item.label}
          aria-current={item.id === active ? "page" : undefined}>
          <Icon />
          <span className="v2-dock-label" aria-hidden="true">{item.label}</span>
          {count > 0 && <span className="v2-dock-count" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
        </Link>;
      })}
    </nav>, document.body);
}
