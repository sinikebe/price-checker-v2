import { Link, useLocation } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import V2BackButton from "./V2BackButton";
import V2Dock from "./V2Dock";
import V2HeaderSearch from "./V2HeaderSearch";
import V2ProfileMenu from "./V2ProfileMenu";
import { backTarget } from "./v2-site-nav";
import "./v2-site-nav.css";

/** The header of the application pages: back button, brand, search and profile menu, and at the end of the page the dock. */
export default function V2SiteHeader({ user, onLogout }: { user: V2User | null; onLogout: () => Promise<void> }) {
  const hasBack = backTarget(useLocation().pathname) !== null;
  return <>
    <header className="v2-header"><div className={hasBack ? "v2-wrap v2-header-inner v2-site-header has-back" : "v2-wrap v2-header-inner v2-site-header"}>
      <div className="v2-site-lead">
        <V2BackButton />
        <Link className="v2-brand" to="/v2" aria-label="Price Checker, accueil V2">
          <span className="v2-brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
          <span className="v2-brand-word">price<span className="v2-brand-accent">checker</span><span className="v2-brand-period">.</span></span>
        </Link>
      </div>
      <V2HeaderSearch />
      <V2ProfileMenu user={user} onLogout={onLogout} />
    </div></header>
    <V2Dock />
  </>;
}
