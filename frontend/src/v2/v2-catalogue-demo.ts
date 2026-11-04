/**
 * The catalogue example of the home page: one branch of the tree, from a department down to three
 * products, with fictional brands, stores and prices (pure, so it can be unit-tested). Two products share
 * a comparable group; the third sits in another group of the same ensemble.
 */
export type DemoProduct = {
  id: string; name: string; brand: string; quantity: string;
  /** Net weight, in grams, for the price per kilogram. */
  grams: number;
  cents: number; store: string; group: string;
};
export type DemoGroup = { name: string; products: DemoProduct[] };
export type CatalogueDemo = { department: string; family: string; scope: string; groups: DemoGroup[] };

/** The anchor of the example on the home page, linked from the catalogue page. */
export const CATALOGUE_DEMO_ID = "exemple-catalogue";

const SPAGHETTI = "Spaghetti";
const PENNE = "Penne rigate";

export const CATALOGUE_DEMO: CatalogueDemo = {
  department: "Épicerie salée",
  family: "Pâtes, riz et céréales",
  scope: "Pâtes sèches",
  groups: [
    { name: SPAGHETTI, products: [
      { id: "spaghetti-500", name: "Spaghetti n° 5", brand: "Marque A", quantity: "500 g", grams: 500, cents: 95, store: "Horizon", group: SPAGHETTI },
      { id: "spaghetti-1000", name: "Spaghetti", brand: "Marque B", quantity: "1 kg", grams: 1000, cents: 159, store: "Marché Lumière", group: SPAGHETTI },
    ] },
    { name: PENNE, products: [
      { id: "penne-1000", name: "Penne rigate", brand: "Marque C", quantity: "1 kg", grams: 1000, cents: 139, store: "Cabas Discount", group: PENNE },
    ] },
  ],
};

/** What a product costs per kilogram, in cents, rounded to the cent. */
export const centsPerKg = (product: DemoProduct) => Math.round(product.cents * 1000 / product.grams);

export type DemoLevel = "group" | "scope";

/**
 * The products compared at this level, the best price per kilogram first: within the first group
 * (the shopper wants spaghetti), or across the whole ensemble (any dry pasta will do).
 */
export function demoRanking(level: DemoLevel, demo: CatalogueDemo = CATALOGUE_DEMO): DemoProduct[] {
  const products = level === "group" ? demo.groups[0].products : demo.groups.flatMap(group => group.products);
  return [...products].sort((left, right) => centsPerKg(left) - centsPerKg(right) || left.cents - right.cents);
}
