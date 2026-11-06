import { cacheRecipeWrite } from "../pwa/cache-writes";
import type { ProductData } from "./v2-products-api";
import { ApiError, apiErrorText, errorDetail } from "./v2-http";

export type RecipeUnit = "g" | "kg" | "ml" | "cl" | "l" | "piece";
export type RecipeIngredient = {
  id?: number; label: string; amount: string | null; unit: RecipeUnit | null;
  note: string; optional: boolean; product_id: number | null; group_name: string | null;
  product?: ProductData | null;
};
export type RecipeInput = {
  title: string; description: string; base_servings: string;
  prep_minutes: number | null; cook_minutes: number | null;
  steps: string[]; ingredients: RecipeIngredient[];
};
export type RecipePublication = { submission_id: number; status: "pending" | "rejected"; revision: number };
export type Recipe = RecipeInput & {
  id: number; revision: number;
  created_at: string; updated_at: string;
  /** Seen by its author only, saved without review; absent from older servers. */
  private?: boolean;
  /** For a private recipe: the latest request to publish it that waits or was refused. */
  publication?: RecipePublication | null;
};
export type RecipeSummary = Pick<Recipe, "id" | "title" | "description" | "base_servings" | "prep_minutes" | "cook_minutes" | "updated_at" | "revision"> & { ingredient_count: number };
export type PrivateRecipeSummary = RecipeSummary & { publication: RecipePublication["status"] | null };
export type PrivateRecipePage = { items: PrivateRecipeSummary[]; limit: number };
export type RecipeSubmission = {
  id: number; recipe_id: number | null; result_recipe_id: number | null;
  title: string; status: "pending" | "approved" | "rejected";
  created_at: string; reviewed_at: string | null;
};
export type RecipeProposal = { submission_id: number; status: "pending"; recipe_id?: number };
export type RecipeReview = {
  id: number; recipe_id: number | null; base_revision: number | null;
  author: string; created_at: string; payload: RecipeInput;
  /** The submission asks to publish its author's private recipe. */
  publishes_private?: boolean;
};
export type RecipePage = { items: RecipeSummary[]; total: number; page: number; page_size: number };

/** Paths under /api/v2/recipes that read or change the signed-in author's private recipes. */
const isPrivateRecipePath = (path: string): boolean => path === "/private" || path.startsWith("/private/") || path.startsWith("/private?");

export async function recipeRequest<T>(path: string, method = "GET", body?: object): Promise<T> {
  const response = await fetch("/api/v2/recipes" + path, {
    method, credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const detail = await errorDetail(response);
    // Recipes also show the first built-in validation message, rather than a generic text.
    const first = Array.isArray(detail) && detail[0] && typeof detail[0] === "object" && "msg" in detail[0]
      ? String(detail[0].msg) : null;
    throw new ApiError(apiErrorText(detail, first ?? "La requête a échoué."), response.status);
  }
  const result = response.status === 204 ? undefined : await response.json();
  // Private recipes never enter the offline copy of public recipes, which every account on
  // this browser can read.
  if (!isPrivateRecipePath(path) && ((method === "DELETE" && /^\/\d+$/.test(path))
    || (method !== "GET" && result && typeof result === "object" && "ingredients" in result)))
    await cacheRecipeWrite(method, path, result as Recipe | undefined);
  return result as T;
}
