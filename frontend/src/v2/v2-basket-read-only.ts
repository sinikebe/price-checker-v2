import { createContext } from "react";

/**
 * Whether a basket page is read only, and why: offline (the lists can still be ticked, nothing else
 * changes until the connection is back), or a shared basket seen through its link without being a
 * member (nothing changes).
 */
export type ReadOnly = false | "offline" | "view";
export const BasketReadOnlyContext = createContext<ReadOnly>(false);

export const OFFLINE_TITLE = "Hors connexion : disponible au retour de la connexion";
const VIEW_TITLE = "Connectez-vous et rejoignez ce panier pour le modifier";
export const readOnlyTitle = (mode: ReadOnly) => mode === "view" ? VIEW_TITLE : OFFLINE_TITLE;
