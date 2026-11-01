import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import { PersonIcon } from "./V2SiteIcons";
import { initials, nextMenuIndex, profileMenuSections, roleLabel } from "./v2-site-nav";
import "./v2-site-nav.css";

/** Profile circle with a menu: account, contribution and administration links, and signing out. */
export default function V2ProfileMenu({ user, onLogout }: { user: V2User | null; onLogout: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const [seenPath, setSeenPath] = useState(pathname);
  if (pathname !== seenPath) { setSeenPath(pathname); setOpen(false); }
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const sections = profileMenuSections(user);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); button.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    root.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const entries = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]"));
    const next = nextMenuIndex(entries.indexOf(document.activeElement as HTMLElement), event.key, entries.length);
    if (next === null) return;
    event.preventDefault();
    entries[next].focus();
  }

  const label = user ? `Menu du compte de ${user.username}` : "Menu du compte";
  return <div className="v2-profile" ref={root}>
    <button ref={button} type="button" className="v2-profile-button" aria-label={label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => setOpen(value => !value)}
      onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}>
      {user ? <span aria-hidden="true">{initials(user.username)}</span> : <PersonIcon />}
    </button>
    {open && <div id={menuId} className="v2-profile-menu" role="menu" aria-label="Compte" onKeyDown={onMenuKeyDown}>
      {user && <div className="v2-profile-menu-user" role="none">
        <strong>{user.username}</strong>{roleLabel(user.role) && <span>{roleLabel(user.role)}</span>}
      </div>}
      {sections.map(section => <div key={section.id} role="group" aria-label={section.heading ?? "Compte"} className="v2-profile-menu-section">
        {section.heading && <div className="v2-profile-menu-heading" aria-hidden="true">{section.heading}</div>}
        {section.links.map(link => <Link key={link.id} role="menuitem" to={link.to} onClick={() => setOpen(false)}>
          {link.label}{link.tag && <span className="v2-beta-tag">{link.tag}</span>}
        </Link>)}
      </div>)}
      {user && <div role="group" aria-label="Session" className="v2-profile-menu-section v2-profile-menu-last">
        <button type="button" role="menuitem" onClick={() => { setOpen(false); void onLogout(); }}>Déconnexion</button>
      </div>}
    </div>}
  </div>;
}
