/** Pure logic of the site navigation: the bottom dock, the profile menu, the back button and the header search (no React, so it can be unit-tested). */

/** The path without its trailing slashes, "/" for the site root: the form every route below is matched on. */
export function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

export type DockId = "home" | "products" | "stores" | "recipes" | "basket" | "shared";
export type DockItem = { id: DockId; label: string; to: string };

/**
 * Two ways to use the application. Shopping (the default, for everyone): baskets and their lists, with
 * a simple view of the products and recipes to fill them. Contribution (signed-in accounts only, for
 * contributors): products, stores, recipes and the tools to add or correct them, without the baskets.
 */
export type AppMode = "shopping" | "contribute";

const HOME: DockItem = { id: "home", label: "Accueil", to: "/v2" };
const PRODUCTS: DockItem = { id: "products", label: "Produits", to: "/v2/produits" };
const STORES: DockItem = { id: "stores", label: "Magasins", to: "/v2/magasins" };
const RECIPES: DockItem = { id: "recipes", label: "Recettes", to: "/v2/recettes" };
const BASKET: DockItem = { id: "basket", label: "Panier", to: "/v2/panier" };
/** The shared basket, next to the personal one, for an account that follows one. */
const SHARED_DOCK_ITEM: DockItem = { id: "shared", label: "Partagé", to: "/v2/panier/partage" };

/** The dock entries for this mode: the shared basket shows once the account follows one; stores are for contributing. */
export function dockItems(mode: AppMode, followsShared: boolean): readonly DockItem[] {
  if (mode === "contribute") return [HOME, PRODUCTS, STORES, RECIPES];
  return followsShared ? [HOME, PRODUCTS, RECIPES, BASKET, SHARED_DOCK_ITEM] : [HOME, PRODUCTS, RECIPES, BASKET];
}

/** Pages that belong to a dock item but sit under another section's path, or none at all. */
const NOT_IN_DOCK = ["/v2/produits/nouveau", "/v2/panier/demo"];

/** The dock item the page belongs to, or null for pages reached from the profile menu. */
export function activeDockId(pathname: string): DockId | null {
  const path = normalizePath(pathname);
  if (path === "/" || path === "/v2") return "home";
  if (NOT_IN_DOCK.some(prefix => path === prefix || path.startsWith(prefix + "/"))) return null;
  const within = (base: string) => path === base || path.startsWith(base + "/");
  if (within("/v2/produits") || within("/v2/categories")) return "products";
  if (within("/v2/magasins")) return "stores";
  if (within("/v2/recettes")) return "recipes";
  if (within("/v2/panier/partage")) return "shared";
  if (within("/v2/panier")) return "basket";
  return null;
}

export type MenuUser = { username: string; role: "admin" | "confirmed" | "visitor" };
export type MenuLink = { id: string; label: string; to: string; tag?: string };
export type MenuSection = { id: string; heading?: string; links: MenuLink[] };

const CONTRIBUTE: MenuSection = {
  id: "contribute", heading: "Contribuer", links: [
    { id: "add-product", label: "Ajouter un produit", to: "/v2/produits/nouveau" },
    { id: "capture", label: "Capturer un prix", to: "/v2/capture/installer", tag: "Bêta" },
    { id: "to-complete", label: "À compléter", to: "/v2/a-completer" },
  ],
};

/**
 * The links of the profile menu for this viewer and mode. Contributing belongs to the contribution mode, open to
 * signed-in accounts. Signing out and the mode switch are buttons, added by the component.
 */
export function profileMenuSections(user: MenuUser | null, mode: AppMode = "shopping"): MenuSection[] {
  if (!user) {
    return [
      { id: "account", links: [
        { id: "login", label: "Connexion", to: "/v2/connexion" },
        { id: "register", label: "Créer un compte", to: "/v2/inscription" },
      ] },
      { id: "preferences", links: [{ id: "settings", label: "Paramètres", to: "/v2/parametres" }] },
    ];
  }
  const sections: MenuSection[] = mode === "contribute" ? [
    { id: "me", links: [
      { id: "drafts", label: "Mes brouillons", to: "/v2/brouillons" },
      { id: "settings", label: "Paramètres", to: "/v2/parametres" },
    ] },
    CONTRIBUTE,
  ] : [{ id: "me", links: [{ id: "settings", label: "Paramètres", to: "/v2/parametres" }] }];
  if (user.role === "admin") {
    sections.push({ id: "admin", heading: "Administration", links: [
      { id: "moderation", label: "À valider", to: "/v2/moderation" },
      { id: "connectors", label: "Connecteurs", to: "/v2/parametres/connecteurs" },
      { id: "server", label: "Serveur", to: "/v2/parametres/serveur" },
    ] });
  }
  return sections;
}

export function roleLabel(role: MenuUser["role"]): string | null {
  return role === "admin" ? "Administrateur" : null;
}

/** One or two capital letters for the profile circle: the first and last words of the name, or the first two letters of a single word. */
export function initials(username: string): string {
  const words = username.trim().split(/[\s._-]+/).filter(Boolean);
  const letters = words.length >= 2
    ? [words[0], words[words.length - 1]].map(word => Array.from(word)[0])
    : Array.from(words[0] ?? "").slice(0, 2);
  return letters.join("").toLocaleUpperCase("fr-FR") || "?";
}

/** Keyboard navigation of a vertical menu: the index to focus after `key`, or null when the key is not handled. */
export function nextMenuIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown": return (current + 1) % count;
    case "ArrowUp": return (current - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}

/** The accessible name of the basket entry in the dock. */
export function basketLabel(count: number): string {
  return count === 0 ? "Panier, vide" : count === 1 ? "Panier, 1 article" : `Panier, ${count} articles`;
}
/** The accessible name of the shared basket entry in the dock. */
export function sharedBasketLabel(count: number): string {
  return count === 0 ? "Panier partagé, vide" : count === 1 ? "Panier partagé, 1 article" : `Panier partagé, ${count} articles`;
}

/**
 * Where the back button goes when the app has no history of its own to return to (a page opened from a
 * bookmark or a shared link): the parent page, never outside the app. Null on the home page.
 */
export function backTarget(pathname: string): string | null {
  const path = normalizePath(pathname);
  if (path === "/" || path === "/v2") return null;
  if (path.startsWith("/v2/categories/")) return "/v2/produits";
  if (path === "/v2/capture/installer" || path === "/v2/panier/demo") return "/v2";
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? "/v2" : "/" + parts.slice(0, -1).join("/");
}

/** The longest search the catalogue accepts. */
export const SEARCH_MAX_LENGTH = 120;

/** The catalogue address that runs this search, or null when there is nothing to search for. */
export function searchPath(term: string): string | null {
  const text = term.replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX_LENGTH).trim();
  return text ? `/v2/produits?${new URLSearchParams({ q: text }).toString()}` : null;
}

/** What the header search field shows: the current catalogue search, or nothing on other pages. */
export function searchTermFromLocation(pathname: string, search: string): string {
  return normalizePath(pathname) === "/v2/produits" ? new URLSearchParams(search).get("q") ?? "" : "";
}

/** The product pages of the workspace: a new product, the account's drafts, moderation, one draft and one product. */
export type WorkspaceMode = "new" | "mine" | "review" | "draft" | "detail" | "edit" | "history";

/** The page an address shows, read once by the application and handed to the gateway. */
export type V2Route =
  | { kind: "home" }
  | { kind: "database" }
  | { kind: "settings"; tab?: string }
  | { kind: "auth"; mode: "login" | "register" }
  | { kind: "stores"; id?: number }
  | { kind: "completion" }
  | { kind: "capture"; mode: "install" | "review" }
  | { kind: "basket"; shared: boolean; demo: boolean; list: boolean }
  | { kind: "recipes"; mode: "list" | "detail" | "new" | "edit"; id?: number; private: boolean }
  | { kind: "catalogue"; category?: string }
  | { kind: "workspace"; mode: WorkspaceMode; id?: number }
  | { kind: "legal"; doc: "mentions" | "confidentialite" | "conditions" }
  | { kind: "versions" }
  | { kind: "changelog"; component?: string };

/**
 * The page at this address, or null for an address the site does not have (the application then goes
 * home). Trailing slashes are ignored. A category name is decoded, and one that cannot be decoded opens
 * the home page; a changelog component stays as written in the address.
 */
export function parseV2Route(pathname: string): V2Route | null {
  const path = normalizePath(pathname);
  switch (path) {
    case "/": case "/v2": return { kind: "home" };
    case "/v2/mentions-legales": return { kind: "legal", doc: "mentions" };
    case "/v2/confidentialite": return { kind: "legal", doc: "confidentialite" };
    case "/v2/conditions-utilisation": return { kind: "legal", doc: "conditions" };
    case "/v2/versions": return { kind: "versions" };
    case "/v2/changelog": return { kind: "changelog" };
    case "/v2/settings/database": return { kind: "database" };
    case "/v2/parametres": return { kind: "settings" };
    case "/v2/connexion": return { kind: "auth", mode: "login" };
    case "/v2/inscription": return { kind: "auth", mode: "register" };
    case "/v2/magasins": return { kind: "stores" };
    case "/v2/a-completer": return { kind: "completion" };
    case "/v2/capture/installer": return { kind: "capture", mode: "install" };
    case "/v2/capture": return { kind: "capture", mode: "review" };
    case "/v2/recettes": return { kind: "recipes", mode: "list", private: false };
    case "/v2/recettes/nouvelle": return { kind: "recipes", mode: "new", private: false };
    case "/v2/produits": return { kind: "catalogue" };
    case "/v2/produits/nouveau": return { kind: "workspace", mode: "new" };
    case "/v2/brouillons": return { kind: "workspace", mode: "mine" };
    case "/v2/moderation": return { kind: "workspace", mode: "review" };
  }
  let match = /^\/v2\/changelog\/([^/]+)$/.exec(path);
  if (match) return { kind: "changelog", component: match[1] };
  match = /^\/v2\/parametres\/([^/]+)$/.exec(path);
  if (match) return { kind: "settings", tab: match[1] };
  match = /^\/v2\/magasins\/(\d+)$/.exec(path);
  if (match) return { kind: "stores", id: Number(match[1]) };
  match = /^\/v2\/panier(\/partage|\/demo)?(\/liste)?$/.exec(path);
  if (match) return { kind: "basket", shared: match[1] === "/partage", demo: match[1] === "/demo", list: Boolean(match[2]) };
  match = /^\/v2\/recettes\/(privees\/)?(\d+)(?:\/(modifier))?$/.exec(path);
  if (match) return { kind: "recipes", mode: match[3] ? "edit" : "detail", id: Number(match[2]), private: Boolean(match[1]) };
  match = /^\/v2\/categories\/([^/]+)$/.exec(path);
  if (match) {
    try { return { kind: "catalogue", category: decodeURIComponent(match[1]) }; }
    catch { return { kind: "home" }; }
  }
  match = /^\/v2\/brouillons\/(\d+)$/.exec(path);
  if (match) return { kind: "workspace", mode: "draft", id: Number(match[1]) };
  match = /^\/v2\/produits\/(\d+)(?:\/(modifier|historique))?$/.exec(path);
  if (match) return { kind: "workspace", mode: match[2] === "modifier" ? "edit" : match[2] === "historique" ? "history" : "detail", id: Number(match[1]) };
  return null;
}
