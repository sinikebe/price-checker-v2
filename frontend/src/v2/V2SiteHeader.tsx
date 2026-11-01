import { Link } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import V2Dock from "./V2Dock";
import V2ProfileMenu from "./V2ProfileMenu";
import "./v2-site-nav.css";

/** The header of the application pages: the brand, the profile menu and, at the end of the page, the dock. */
export default function V2SiteHeader({ user, onLogout }: { user: V2User | null; onLogout: () => Promise<void> }) {
  return <>
    <header className="v2-header"><div className="v2-wrap v2-header-inner v2-site-header">
      <Link className="v2-brand" to="/v2" aria-label="Price Checker, accueil V2">
        <span className="v2-brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
        <span>price<span className="v2-brand-accent">checker</span><span className="v2-brand-period">.</span></span>
      </Link>
      <V2ProfileMenu user={user} onLogout={onLogout} />
    </div></header>
    <V2Dock />
  </>;
}
