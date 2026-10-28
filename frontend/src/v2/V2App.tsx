import { useLayoutEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import V2Gateway from "./V2Gateway";
import V2VersionsPage from "./V2VersionsPage";
import V2ChangelogPage from "./V2ChangelogPage";
import V2LegalPage from "./V2LegalPage";
import V2SiteFooter from "./V2SiteFooter";
import { V2BasketProvider } from "./V2BasketContext";

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
  const path = useLocation().pathname.replace(/\/+$/, "") || "/";
  const store = path.match(/^\/v2\/magasins\/(\d+)$/);
  const product = path.match(/^\/v2\/produits\/(\d+)(?:\/(modifier|historique))?$/);
  const isProductRoute = Boolean(product);
  useLayoutEffect(() => { if (isProductRoute) window.scrollTo(0, 0); }, [path, isProductRoute]);
  const category = path.match(/^\/v2\/categories\/([^/]+)$/);
  let categoryName: string | undefined;
  try { categoryName = category ? decodeURIComponent(category[1]) : undefined; }
  catch { categoryName = undefined; }
  const recipe = path.match(/^\/v2\/recettes\/(\d+)(?:\/(modifier))?$/);
  const draft = path.match(/^\/v2\/brouillons\/(\d+)$/);
  const recipeMode = path === "/v2/recettes" ? "list"
    : path === "/v2/recettes/nouvelle" ? "new"
    : recipe ? recipe[2] ? "edit" : "detail" : undefined;
  const workspaceMode = path === "/v2/produits" ? "catalogue"
    : path === "/v2/produits/nouveau" ? "new"
    : path === "/v2/brouillons" ? "mine"
    : path === "/v2/moderation" ? "review"
    : draft ? "draft"
    : product ? product[2] === "modifier" ? "edit" : product[2] === "historique" ? "history" : "detail"
    : undefined;

  const captureMode = path === "/v2/capture/installer" ? "install" : path === "/v2/capture" ? "review" : undefined;

  if (path === "/v2/mentions-legales") return withFooter(<V2LegalPage kind="mentions" />);
  if (path === "/v2/confidentialite") return withFooter(<V2LegalPage kind="confidentialite" />);
  if (path === "/v2/conditions-utilisation") return withFooter(<V2LegalPage kind="conditions" />);
  if (path === "/v2/versions") return withFooter(<V2VersionsPage />);
  if (path === "/v2/changelog") return withFooter(<V2ChangelogPage />);
  const changelogComponent = path.match(/^\/v2\/changelog\/([^/]+)$/);
  if (changelogComponent) return withFooter(<V2ChangelogPage componentId={changelogComponent[1]} />);
  if (path === "/" || path === "/v2") return withFooter(<V2BasketProvider><V2Gateway /></V2BasketProvider>);
  if (["/v2/parametres", "/v2/settings/database", "/v2/connexion", "/v2/inscription"].includes(path)
    || workspaceMode || category || recipeMode || captureMode || path === "/v2/a-completer" || path === "/v2/panier" || path === "/v2/magasins" || store) {
    return withFooter(<V2BasketProvider><V2Gateway
      settingsMode={path === "/v2/settings/database"}
      preferencesMode={path === "/v2/parametres"}
      authMode={path === "/v2/connexion" ? "login" : path === "/v2/inscription" ? "register" : undefined}
      recipeMode={recipeMode}
      captureMode={captureMode}
      completionMode={path === "/v2/a-completer"}
      basketMode={path === "/v2/panier"}
      storesMode={path === "/v2/magasins" || Boolean(store)}
      storeId={store ? Number(store[1]) : undefined}
      recipeId={recipe ? Number(recipe[1]) : undefined}
      categoryName={categoryName}
      workspaceMode={workspaceMode}
      workspaceId={draft ? Number(draft[1]) : product ? Number(product[1]) : undefined}
    /></V2BasketProvider>);
  }
  return <Navigate to="/v2" replace />;
}
