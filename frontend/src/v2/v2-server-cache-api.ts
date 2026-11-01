export type CacheUsage = {
  at: string; stale: boolean;
  disk: { total_bytes: number; used_bytes: number; available_bytes: number };
  images: { count: number; dangling: number; size_bytes: number; reclaimable_bytes: number };
  build_cache: { size_bytes: number; reclaimable_bytes: number };
  backups: { count: number; bytes: number };
};
export type CacheRun = { at: string; result: "done" | "failed" | "running"; trigger: "manual" | "update"; freed_bytes?: number; message?: string };
export type ServerCache = { scheduler_installed: boolean; state: "queued" | "running" | null; usage: CacheUsage | null; last_run: CacheRun | null };

async function request(method: "GET" | "POST"): Promise<ServerCache> {
  const response = await fetch(method === "POST" ? "/api/v2/server-cache/clean" : "/api/v2/server-cache", {
    method, credentials: "same-origin", cache: "no-store",
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : null;
    throw new Error(typeof detail === "string" ? detail : "L’espace disque n’a pas pu être chargé.");
  }
  return response.json() as Promise<ServerCache>;
}
export const getServerCache = () => request("GET");
export const requestCacheClean = () => request("POST");

const bytes = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
/** Decimal units, like Docker and most disk tools. */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return `${Math.round(value)} o`;
  const units = ["ko", "Mo", "Go", "To"];
  let size = value / 1000, index = 0;
  while (size >= 1000 && index < units.length - 1) { size /= 1000; index += 1; }
  return `${index === 0 ? Math.round(size) : bytes.format(size)} ${units[index]}`;
}

export function diskPercent(disk: CacheUsage["disk"]): number {
  return disk.total_bytes > 0 ? Math.max(0, Math.min(100, Math.round(100 * disk.used_bytes / disk.total_bytes))) : 0;
}
/** The same 80 % threshold as the host alerts. */
export const diskLevel = (percent: number): "ok" | "warning" | "high" => percent > 90 ? "high" : percent > 80 ? "warning" : "ok";

export const momentLabel = (iso: string) => new Date(iso).toLocaleString("fr-FR", {
  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function lastRunSummary(run: CacheRun, when: (iso: string) => string = momentLabel): string {
  const origin = run.trigger === "update" ? "après une mise à jour" : "demandé depuis cette page";
  if (run.result === "failed") return `Dernier nettoyage ${when(run.at)} (${origin}) : échec${run.message ? ` — ${run.message}` : ""}.`;
  if (run.result === "running") return `Nettoyage commencé ${when(run.at)}.`;
  return `Dernier nettoyage ${when(run.at)} (${origin}) : ${typeof run.freed_bytes === "number" ? `${formatBytes(run.freed_bytes)} libérés` : "terminé"}.`;
}
