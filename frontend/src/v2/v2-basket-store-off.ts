/** Stores left out of the basket split by hand (still in the filters), kept in this browser, per account. */
const KEY = /^\d{1,19}:(?:in_store|drive|delivery)$/;
export const MAX_STORES_OFF = 50;

export function parseStoresOff(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const keys: string[] = [];
  for (const value of raw) {
    if (typeof value === "string" && KEY.test(value) && !keys.includes(value)) keys.push(value);
    if (keys.length >= MAX_STORES_OFF) break;
  }
  return keys;
}

const storageKey = (userId: number | null) => `v2:basket:stores-off:${userId ?? "anonymous"}`;
export function readStoresOff(userId: number | null): string[] {
  try { return parseStoresOff(JSON.parse(localStorage.getItem(storageKey(userId)) ?? "[]")); } catch { return []; }
}
export function writeStoresOff(userId: number | null, keys: string[]): void {
  try { localStorage.setItem(storageKey(userId), JSON.stringify(keys)); } catch { /* the current tab still works */ }
}

/** The keys with one store switched off (`off`) or back on, bounded and without duplicates. */
export function withStoreOff(keys: readonly string[], key: string, off: boolean): string[] {
  if (!KEY.test(key)) return [...keys];
  const rest = keys.filter(value => value !== key);
  return off ? parseStoresOff([...rest, key]) : rest;
}
