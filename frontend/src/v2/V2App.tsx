import { Navigate, useLocation } from "react-router-dom";
import V2Gateway from "./V2Gateway";
import V2VersionsPage from "./V2VersionsPage";
import { V2BasketProvider } from "./V2BasketContext";

export default function V2App() {
  const path = useLocation().pathname.replace(/\/+$/, "") || "/";
  const product = path.match(/^\/v2\/produits\/(\d+)(?:\/(modifier|historique))?$/);
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

  if (path === "/v2/versions") return <V2VersionsPage />;
  if (path === "/" || path === "/v2") return <V2BasketProvider><V2Gateway /></V2BasketProvider>;
  if (["/v2/settings/database", "/v2/connexion", "/v2/inscription"].includes(path)
    || workspaceMode || recipeMode || path === "/v2/panier") {
    return <V2BasketProvider><V2Gateway
      settingsMode={path === "/v2/settings/database"}
      authMode={path === "/v2/connexion" ? "login" : path === "/v2/inscription" ? "register" : undefined}
      recipeMode={recipeMode}
      basketMode={path === "/v2/panier"}
      recipeId={recipe ? Number(recipe[1]) : undefined}
      workspaceMode={workspaceMode}
      workspaceId={draft ? Number(draft[1]) : product ? Number(product[1]) : undefined}
    /></V2BasketProvider>;
  }
  return <Navigate to="/v2" replace />;
}
