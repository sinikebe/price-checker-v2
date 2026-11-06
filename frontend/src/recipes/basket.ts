import type { BasketItem, BasketQuantity } from "../v2/v2-basket-storage";
import type { Product } from "../v2/v2-products-api";
import type { Recipe } from "../v2/v2-recipes-api";
import { scaledAmount } from "./quantity";

/** What the reader chose on the recipe page, by ingredient position. */
export type RecipeBasketChoice = {
  /** The published catalogue. */
  products: Product[];
  /** Current products replacing references that left the catalogue, by referenced id. */
  resolved: Record<number, Product>;
  /** A product picked within the group of an ingredient (0: automatic choice). */
  selected: Record<number, number>;
  /** Optional ingredients the reader ticked. */
  included: Record<number, boolean>;
};
export type RecipeBasketEntry = { item: BasketItem; quantity: BasketQuantity };

/**
 * The basket lines for `recipe` made for `servings` portions, or the reason none is added: the
 * recipe goes in whole or not at all. An ingredient without quantity counts as one package.
 */
export function recipeBasketEntries(recipe: Recipe, servings: string, choice: RecipeBasketChoice): { entries: RecipeBasketEntry[] } | { error: string } {
  const { products, resolved, selected: selectedProducts, included } = choice;
  const entries: RecipeBasketEntry[] = [];
  const unavailable: string[] = [];
  for (const [index, ingredient] of recipe.ingredients.entries()) {
    if (ingredient.optional && included[index] !== true) continue;
    const selected = selectedProducts[index] ?? 0;
    const product = selected ? products.find(value => value.id === selected)
      : products.find(value => value.id === ingredient.product_id)
        ?? (ingredient.product_id ? resolved[ingredient.product_id] : undefined);
    const item: BasketItem | null = product ?? (ingredient.group_name && !selected
      ? { kind: "group", name: ingredient.group_name } : null);
    if (!item) { unavailable.push(ingredient.label); continue; }
    let quantity: BasketQuantity = { amount: "1", unit: "package" };
    if (ingredient.amount && ingredient.unit) {
      const amount = scaledAmount(ingredient.amount, servings, recipe.base_servings);
      if (amount === null || Number(amount) <= 0 || Number(amount) > 999999) { unavailable.push(ingredient.label); continue; }
      quantity = { amount, unit: ingredient.unit };
    }
    entries.push({ item, quantity });
  }
  if (!entries.length) return { error: "Aucun ingrédient sélectionné." };
  if (unavailable.length) return { error: "Ingrédients sans produit disponible ou quantité valide : " + unavailable.join(", ") + ". Aucun ingrédient ajouté." };
  return { entries };
}
