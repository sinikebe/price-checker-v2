import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import V2Gateway from "./V2Gateway";
import V2VersionsPage from "./V2VersionsPage";
import V2ChangelogPage from "./V2ChangelogPage";
import V2LegalPage from "./V2LegalPage";
import V2SiteFooter from "./V2SiteFooter";
import { V2BasketProvider } from "./V2BasketContext";
import { reportPage } from "./v2-page-traffic";
import { normalizePath, parseV2Route } from "./v2-site-nav";

const NOTICE_DISMISSED_KEY = "v2-early-notice-dismissed";

function V2EarlyNotice() {
  const [dismissed, setDismissed] = useState(() => {
    try { return window.sessionStorage.getItem(NOTICE_DISMISSED_KEY) === "1"; }
    catch { return false; }
  });
  if (dismissed) return null;

  function dismiss() {
    try { window.sessionStorage.setItem(NOTICE_DISMISSED_KEY, "1"); }
    catch { /* The notice can still be closed when browser storage is unavailable. */ }
    setDismissed(true);
  }

  return <aside className="v2-early-notice" aria-label="Information sur la version du site">
    <div className="v2-early-notice-inner">
      <p><strong>Version en développement.</strong> Price Checker est encore en phase initiale : certaines fonctions peuvent évoluer ou être incomplètes.</p>
      <button type="button" onClick={dismiss} aria-label="Fermer le bandeau d’information">Fermer</button>
    </div>
  </aside>;
}

function withFooter(page: ReactNode) {
  return <><V2EarlyNotice />{page}<V2SiteFooter /></>;
}

export default function V2App() {
  const path = normalizePath(useLocation().pathname);
  const route = parseV2Route(path);
  // A product page opens at its top, even when the previous page was scrolled down.
  const scrollsToTop = route?.kind === "workspace" && (route.mode === "detail" || route.mode === "edit" || route.mode === "history");
  useLayoutEffect(() => { if (scrollsToTop) window.scrollTo(0, 0); }, [path, scrollsToTop]);
  useEffect(() => { reportPage(path); }, [path]);

  if (!route) return <Navigate to="/v2" replace />;
  if (route.kind === "legal") return withFooter(<V2LegalPage kind={route.doc} />);
  if (route.kind === "versions") return withFooter(<V2VersionsPage />);
  if (route.kind === "changelog") return withFooter(<V2ChangelogPage componentId={route.component} />);
  // Every other page goes through the gateway, kept mounted from one page to the next.
  return withFooter(<V2BasketProvider><V2Gateway route={route} /></V2BasketProvider>);
}
