import { cacheRecipeWrite } from "../pwa/cache-writes";
import type { ProductData } from "./v2-products-api";

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
export type Recipe = RecipeInput & {
  id: number; revision: number;
  created_at: string; updated_at: string;
};
export type RecipeSummary = Pick<Recipe, "id" | "title" | "description" | "base_servings" | "prep_minutes" | "cook_minutes" | "updated_at" | "revision"> & { ingredient_count: number };
export type RecipePage = { items: RecipeSummary[]; total: number; page: number; page_size: number };

export async function recipeRequest<T>(path: string, method = "GET", body?: object): Promise<T> {
  const response = await fetch("/api/v2/recipes" + path, {
    method, credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const detail = data && typeof data === "object" && "detail" in data
      ? (data as { detail: unknown }).detail : null;
    const validation = Array.isArray(detail) && detail[0] && typeof detail[0] === "object" && "msg" in detail[0]
      ? String(detail[0].msg) : null;
    throw new Error(typeof detail === "string" ? detail : validation ?? "La requête a échoué.");
  }
  const result = response.status === 204 ? undefined : await response.json();
  if (method !== "GET") await cacheRecipeWrite(method, path, result as Recipe | undefined);
  return result as T;
}
