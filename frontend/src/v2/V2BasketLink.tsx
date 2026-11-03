import { useContext, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { BasketLinksContext } from "./v2-basket-links";

/** A link to an article's page, or its plain name where the basket has no catalogue behind it (the demo). */
export default function V2BasketLink({ to, children }: { to: string; children: ReactNode }) {
  return useContext(BasketLinksContext) ? <Link to={to}>{children}</Link> : <span className="v2-basket-unlinked">{children}</span>;
}
