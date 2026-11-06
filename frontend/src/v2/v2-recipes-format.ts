import type { V2User } from "./v2-auth-api";
import type { Product } from "./v2-products-api";
import type { RecipeUnit } from "./v2-recipes-api";
import { errorText } from "./v2-http";

// What the recipe pages (list, detail and editor) share: their props, addresses and texts.

export type Mode = "list" | "detail" | "new" | "edit";
export type Props = { mode: Mode; id?: number; privateRecipe?: boolean; user: V2User | null; onLogout: () => Promise<void> };
export const productName = (product: Product["data"]) => [product.brand, product.name, product.quantity].filter(Boolean).join(" · ");
export const message = (error: unknown) => errorText(error, "Une erreur est survenue.");
export const privatePath = (id: number) => `/v2/recettes/privees/${id}`;
export const PRIVATE_NOTE = "Visible par vous seul, enregistrée tout de suite, sans validation. Elle ne rapporte pas de crédits.";
/** A unit as read on the page: "pièce(s)" for pieces, the symbol otherwise. */
export const unitLabel = (unit: RecipeUnit | string | null) => unit === "piece" ? "pièce(s)" : unit ?? "";
