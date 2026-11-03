import { createContext } from "react";

/**
 * Whether a basket page is read only: offline, baskets and lists can be read and the lists ticked,
 * nothing else changes until the connection is back.
 */
export const BasketReadOnlyContext = createContext(false);

export const OFFLINE_TITLE = "Hors connexion : disponible au retour de la connexion";
