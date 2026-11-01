export type LogLevel = "debug" | "info" | "warning" | "error";
export type LogSource = "system" | "connector" | "basket";
export type LogPeriod = "1h" | "24h" | "7d" | "30d";
export type LogItem = {
  id: number; at: string; level: LogLevel; source: LogSource; event: string; connector: string | null;
  data: Record<string, number | boolean | string>;
};
export type LogPage = { items: LogItem[]; next_before: string | null; counts: Partial<Record<LogLevel, number>>; connectors: string[] };
export type LogFilters = { level: LogLevel; sources: LogSource[]; connector: string; period: LogPeriod };

export const LEVELS: { id: LogLevel; label: string }[] = [
  { id: "debug", label: "Détail" }, { id: "info", label: "Information" }, { id: "warning", label: "Alerte" }, { id: "error", label: "Erreur" },
];
export const SOURCES: { id: LogSource; label: string }[] = [
  { id: "system", label: "Système" }, { id: "connector", label: "Connecteurs" }, { id: "basket", label: "Panier" },
];
export const PERIODS: { id: LogPeriod; label: string }[] = [
  { id: "1h", label: "Dernière heure" }, { id: "24h", label: "24 heures" }, { id: "7d", label: "7 jours" }, { id: "30d", label: "30 jours" },
];
export const defaultLogFilters: LogFilters = { level: "info", sources: [], connector: "", period: "24h" };

/** The query string of a page of events; an empty source list means every source. */
export function logQuery(filters: LogFilters, before?: string | null): string {
  const query = new URLSearchParams({ level: filters.level, period: filters.period, limit: "100" });
  for (const source of filters.sources) query.append("source", source);
  if (filters.connector) query.set("connector", filters.connector);
  if (before) query.set("before", before);
  return query.toString();
}

export async function getLogs(filters: LogFilters, before?: string | null, signal?: AbortSignal): Promise<LogPage> {
  const response = await fetch("/api/v2/logs?" + logQuery(filters, before), { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new Error("Le journal n’a pas pu être chargé.");
  return response.json() as Promise<LogPage>;
}
