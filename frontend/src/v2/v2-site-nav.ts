/** Pure logic of the site navigation: the bottom dock and the profile menu (no React, so it can be unit-tested). */

export type DockId = "home" | "products" | "stores" | "recipes" | "basket";
export type DockItem = { id: DockId; label: string; to: string };

export const DOCK_ITEMS: readonly DockItem[] = [
  { id: "home", label: "Accueil", to: "/v2" },
  { id: "products", label: "Produits", to: "/v2/produits" },
  { id: "stores", label: "Magasins", to: "/v2/magasins" },
  { id: "recipes", label: "Recettes", to: "/v2/recettes" },
  { id: "basket", label: "Panier", to: "/v2/panier" },
];

/** Pages that belong to a dock item but sit under another section's path, or none at all. */
const NOT_IN_DOCK = ["/v2/produits/nouveau"];

/** The dock item the page belongs to, or null for pages reached from the profile menu. */
export function activeDockId(pathname: string): DockId | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/v2") return "home";
  if (NOT_IN_DOCK.some(prefix => path === prefix || path.startsWith(prefix + "/"))) return null;
  const within = (base: string) => path === base || path.startsWith(base + "/");
  if (within("/v2/produits") || within("/v2/categories")) return "products";
  if (within("/v2/magasins")) return "stores";
  if (within("/v2/recettes")) return "recipes";
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

/** The links of the profile menu for this viewer. Signing out is a button and is added by the component. */
export function profileMenuSections(user: MenuUser | null): MenuSection[] {
  if (!user) {
    return [
      { id: "account", links: [
        { id: "login", label: "Connexion", to: "/v2/connexion" },
        { id: "register", label: "Créer un compte", to: "/v2/inscription" },
      ] },
      CONTRIBUTE,
      { id: "preferences", links: [{ id: "settings", label: "Paramètres", to: "/v2/parametres" }] },
    ];
  }
  const sections: MenuSection[] = [
    { id: "me", links: [
      { id: "drafts", label: "Mes brouillons", to: "/v2/brouillons" },
      { id: "settings", label: "Paramètres", to: "/v2/parametres" },
    ] },
    CONTRIBUTE,
  ];
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

const normalize = (pathname: string) => pathname.replace(/\/+$/, "") || "/";

/**
 * Where the back button goes when the app has no history of its own to return to (a page opened from a
 * bookmark or a shared link): the parent page, never outside the app. Null on the home page.
 */
export function backTarget(pathname: string): string | null {
  const path = normalize(pathname);
  if (path === "/" || path === "/v2") return null;
  if (path.startsWith("/v2/categories/")) return "/v2/produits";
  if (path === "/v2/capture/installer") return "/v2";
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
  return normalize(pathname) === "/v2/produits" ? new URLSearchParams(search).get("q") ?? "" : "";
}
