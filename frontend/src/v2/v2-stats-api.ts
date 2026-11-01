export type StatsPeriod = "1h" | "24h" | "7d" | "30d";
export type Endpoint = {
  method: string; route: string; requests: number; per_hour: number; client_errors: number; server_errors: number;
  average_ms: number; max_ms: number;
};
export type Stats = {
  period: StatsPeriod; since: string; until: string; hours: number; recording_since: string | null;
  requests: { total: number; client_errors: number; server_errors: number };
  groups: Record<string, { requests: number; errors: number }>;
  endpoints: Endpoint[];
  contributions: Record<string, number>;
  traffic: { page_views: number; visits: number; accounts_created: number; pages: { page: string; views: number; visits: number }[] };
};

export const STATS_PERIODS: { id: StatsPeriod; label: string }[] = [
  { id: "1h", label: "1 heure" }, { id: "24h", label: "24 heures" }, { id: "7d", label: "7 jours" }, { id: "30d", label: "30 jours" },
];
export const GROUP_LABELS: Record<string, string> = {
  basket: "Panier", prices: "Prix", products: "Produits", catalogue: "Catalogue", recipes: "Recettes", stores: "Magasins",
  accounts: "Comptes", connectors: "Connecteurs", other: "Autres",
};
export const CONTRIBUTION_LABELS: Record<string, string> = {
  product_proposals: "Fiches produit proposées", product_proposals_approved: "Fiches produit validées",
  price_proposals: "Relevés de prix proposés", price_proposals_approved: "Relevés de prix validés",
  prices_manual: "Prix publiés à la main", prices_bookmarklet: "Prix publiés par le bookmarklet",
  prices_connector: "Prix lus par les connecteurs", prices_open_prices: "Prix importés d’Open Prices",
  recipes_created: "Recettes créées", recipe_submissions: "Recettes proposées", reports: "Signalements",
  merges: "Fusions de doublons", store_aliases: "Alias de magasin",
};
export const PAGE_LABELS: Record<string, string> = {
  home: "Accueil", products: "Produits", product: "Fiche produit", product_edit: "Édition de produit", category: "Groupe de produits",
  stores: "Magasins", store: "Fiche magasin", recipes: "Recettes", recipe: "Recette", basket: "Panier", settings: "Paramètres",
  capture: "Capture de prix", completion: "À compléter", auth: "Connexion et inscription", versions: "Versions",
  changelog: "Nouveautés", legal: "Mentions légales", other: "Autres pages",
};

export async function getStats(period: StatsPeriod, signal?: AbortSignal): Promise<Stats> {
  const response = await fetch(`/api/v2/stats?period=${period}`, { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new Error("Les statistiques n’ont pas pu être chargées.");
  return response.json() as Promise<Stats>;
}

export type EndpointSort = "requests" | "per_hour" | "errors" | "average_ms";
/** A sorted copy; ties keep the busiest endpoint first, then the route name. */
export function sortEndpoints(items: readonly Endpoint[], by: EndpointSort): Endpoint[] {
  const value = (item: Endpoint) => by === "errors" ? item.client_errors + item.server_errors : item[by];
  return [...items].sort((a, b) => value(b) - value(a) || b.requests - a.requests || a.route.localeCompare(b.route) || a.method.localeCompare(b.method));
}

const count = new Intl.NumberFormat("fr-FR");
export const formatCount = (value: number) => count.format(value);
export const formatRate = (value: number) => value >= 10 ? count.format(Math.round(value)) : new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(value);

/** True when the counters started after the beginning of the period, so the figures are partial. */
export function partialPeriod(stats: Pick<Stats, "since" | "recording_since">): boolean {
  return stats.recording_since === null || new Date(stats.recording_since).getTime() > new Date(stats.since).getTime() + 5 * 60_000;
}
