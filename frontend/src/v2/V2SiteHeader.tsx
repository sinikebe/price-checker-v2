import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import V2BackButton from "./V2BackButton";
import V2Brand from "./V2Brand";
import V2Dock from "./V2Dock";
import V2HeaderSearch from "./V2HeaderSearch";
import V2ModeBadge from "./V2ModeBadge";
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
        <V2Brand wordClassName="v2-brand-word" />
      </div>
      <V2HeaderSearch />
      <div className="v2-site-end"><V2ModeBadge /><V2ProfileMenu user={user} onLogout={onLogout} /></div>
    </div></header>
    <V2Dock />
  </>;
}

/** Each section's page classes: the outer one, then the id and the class of its main region. */
const SECTIONS = {
  workspace: ["v2-workspace", "v2-workspace-main", "v2-workspace-main"],
  recipes: ["v2-recipes", "v2-recipes-main", "v2-recipes-main"],
  basket: ["v2-recipes", "v2-basket-main", "v2-recipes-main"],
  settings: ["v2-settings", "v2-settings-main", "v2-settings-main"],
} as const;

/** An application page: the skip link, the site header and the main region of its section. */
export function V2PageFrame({ section = "workspace", user, onLogout, children }: {
  section?: keyof typeof SECTIONS; user: V2User | null; onLogout: () => Promise<void>; children: ReactNode;
}) {
  const [outer, id, main] = SECTIONS[section];
  return <div className={"v2-home " + outer}>
    <a className="v2-skip" href={"#" + id}>Aller au contenu</a>
    <V2SiteHeader user={user} onLogout={onLogout} />
    <main id={id} className={"v2-wrap " + main}>{children}</main>
  </div>;
}
