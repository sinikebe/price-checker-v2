/**
 * Prices already paid for, kept in this browser so that coming back to a page costs nothing:
 * they are shown with their date until the reader asks for fresh ones. One entry per page, per
 * reader (an account, or "visitor"); the oldest entries go first.
 */
export type PaidEntry<T> = { fetchedAt: string; data: T };
export type PaidKind = "product" | "category" | "comparison";
export const MAX_PAID_ENTRIES = 60;
export const MAX_PAID_BYTES = 400_000;

export const viewerKey = (userId: number | null) => userId ? `user:${userId}` : "visitor";
const entryKey = (viewer: string, kind: PaidKind, id: string) => `v2:prices:${viewer}:${kind}:${id}`;
const indexKey = (viewer: string) => `v2:prices:${viewer}:index`;

function readIndex(viewer: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(indexKey(viewer)) ?? "[]");
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string" && key.startsWith(`v2:prices:${viewer}:`)) : [];
  } catch { return []; }
}

export function readPaid<T>(viewer: string, kind: PaidKind, id: string): PaidEntry<T> | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(entryKey(viewer, kind, id)) ?? "null");
    if (!value || typeof value !== "object") return null;
    const entry = value as PaidEntry<T>;
    return typeof entry.fetchedAt === "string" && !Number.isNaN(Date.parse(entry.fetchedAt)) && entry.data && typeof entry.data === "object" ? entry : null;
  } catch { return null; }
}

/** Keep paid prices; returns false when the browser could not (too big, storage full or blocked). */
export function writePaid<T>(viewer: string, kind: PaidKind, id: string, data: T, now: Date = new Date()): boolean {
  const key = entryKey(viewer, kind, id);
  const text = JSON.stringify({ fetchedAt: now.toISOString(), data });
  if (text.length > MAX_PAID_BYTES) return false;
  try {
    const index = readIndex(viewer).filter(item => item !== key);
    index.push(key);
    while (index.length > MAX_PAID_ENTRIES) localStorage.removeItem(index.shift()!);
    try { localStorage.setItem(key, text); }
    catch {
      // Storage full: make room with the older half, once.
      for (const old of index.splice(0, Math.floor(index.length / 2))) localStorage.removeItem(old);
      localStorage.setItem(key, text);
    }
    localStorage.setItem(indexKey(viewer), JSON.stringify(index));
    return true;
  } catch { return false; }
}
