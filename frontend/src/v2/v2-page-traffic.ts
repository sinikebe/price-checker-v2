/** Anonymous page traffic: a page name from a fixed list, never the address, an id or a title. */
const SESSION_KEY = "v2:traffic:visit";

export function pageKeyForPath(pathname: string): string {
  const path = pathname.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/v2") return "home";
  if (path === "/v2/produits") return "products";
  if (path === "/v2/produits/nouveau" || /^\/v2\/produits\/\d+\/modifier$/.test(path) || path === "/v2/brouillons" || /^\/v2\/brouillons\/\d+$/.test(path)) return "product_edit";
  if (/^\/v2\/produits\/\d+(?:\/historique)?$/.test(path)) return "product";
  if (/^\/v2\/categories\/[^/]+$/.test(path)) return "category";
  if (path === "/v2/magasins") return "stores";
  if (/^\/v2\/magasins\/\d+$/.test(path)) return "store";
  if (path === "/v2/recettes") return "recipes";
  if (/^\/v2\/recettes\/(?:\d+(?:\/modifier)?|nouvelle)$/.test(path)) return "recipe";
  if (path === "/v2/panier") return "basket";
  if (path === "/v2/parametres" || path.startsWith("/v2/parametres/") || path === "/v2/settings/database") return "settings";
  if (path === "/v2/capture" || path === "/v2/capture/installer") return "capture";
  if (path === "/v2/a-completer") return "completion";
  if (path === "/v2/connexion" || path === "/v2/inscription") return "auth";
  if (path === "/v2/versions") return "versions";
  if (path === "/v2/changelog" || path.startsWith("/v2/changelog/")) return "changelog";
  if (["/v2/mentions-legales", "/v2/confidentialite", "/v2/conditions-utilisation"].includes(path)) return "legal";
  return "other";
}

/** The first page of a browser tab session counts as a visit. Nothing is stored beyond that flag. */
export function reportPage(pathname: string): void {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  let visit = false;
  try {
    if (sessionStorage.getItem(SESSION_KEY) !== "1") { sessionStorage.setItem(SESSION_KEY, "1"); visit = true; }
  } catch { /* without storage every page view is simply not a visit */ }
  void fetch("/api/v2/stats/page", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page: pageKeyForPath(pathname), visit }),
    keepalive: true, credentials: "omit",
  }).catch(() => { /* counting is optional */ });
}
