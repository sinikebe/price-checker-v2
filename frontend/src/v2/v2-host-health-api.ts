type Hour = { hour: string; cpu_avg: number | null; cpu_max: number | null;
  memory_avg: number; memory_max: number; disk_pct: number; samples: number; cpu_samples: number };
export type Alert = { metric: "cpu" | "memory" | "disk"; at: string; pct: number };
type Resource = { total_bytes: number; used_bytes: number; available_bytes: number; pct: number };
export type Health = { available: false; reason: string } | { available: true; stale: boolean; updated_at: string;
  current: { cpu_pct: number | null; memory: Resource; disk: Resource }; hourly: Hour[]; alerts: Alert[] };

export const metricNames = { cpu: "Processeur", memory: "Mémoire", disk: "Stockage" };
export async function getHealth(): Promise<Health> {
  const response = await fetch("/api/v2/host-health", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("Les mesures de l’hôte ne sont pas disponibles.");
  return response.json() as Promise<Health>;
}
