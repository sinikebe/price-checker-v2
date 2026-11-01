import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import { useV2Basket } from "./V2BasketContext";
import { CartIcon, HomeIcon, ProductsIcon, RecipesIcon, StoreIcon } from "./V2SiteIcons";
import { DOCK_ITEMS, activeDockId, basketLabel, type DockId } from "./v2-site-nav";
import "./v2-site-nav.css";

const ICONS: Record<DockId, () => React.JSX.Element> = {
  home: HomeIcon, products: ProductsIcon, stores: StoreIcon, recipes: RecipesIcon, basket: CartIcon,
};

/** Floating bottom bar with the main sections: icons only, and the name of the current one. */
export default function V2Dock() {
  const { pathname } = useLocation();
  const { items } = useV2Basket();
  const active = activeDockId(pathname);
  useEffect(() => {
    document.body.classList.add("v2-has-dock");
    return () => document.body.classList.remove("v2-has-dock");
  }, []);
  // Rendered at the end of the page so that it comes last in the reading and tab order.
  return createPortal(
    <nav className="v2-dock" aria-label="Navigation principale">
      {DOCK_ITEMS.map(item => {
        const Icon = ICONS[item.id];
        const count = item.id === "basket" ? items.length : 0;
        return <Link key={item.id} className="v2-dock-item" to={item.to} title={item.label}
          aria-label={item.id === "basket" ? basketLabel(count) : item.label}
          aria-current={item.id === active ? "page" : undefined}>
          <Icon />
          <span className="v2-dock-label" aria-hidden="true">{item.label}</span>
          {count > 0 && <span className="v2-dock-count" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
        </Link>;
      })}
    </nav>, document.body);
}
