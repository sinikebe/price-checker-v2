/**
 * Saved shopping lists, without React: their shape, the changes kept while offline, and their copy in
 * this browser. No value import, so the tests can load this file on its own.
 */
import type { BasketQuantity } from "./v2-basket-storage";
import type { LineRef } from "./v2-shared-basket";

export type SavedListLine = {
  key: string; label: string; detail?: string; packages?: number; cents?: number | null; missing?: boolean;
  /** The article to put back in a basket. */
  line?: LineRef | null; quantity?: BasketQuantity | null;
};
/** A store (retailer set), or the articles no store prices (retailer null). */
export type SavedListSection = { retailer: string | null; store?: string; cents?: number; lines: SavedListLine[] };
export type SavedListContent = {
  source: "basket" | "shared"; source_name?: string | null; store_mode?: boolean; fetched_at?: string | null;
  sections: SavedListSection[];
};
export type SavedList = {
  id: string; name: string; content: SavedListContent; checked: string[];
  revision?: number; created_at: string; updated_at: string;
};
/** A change kept until the server confirms it; a whole list is sent, so a retry is harmless. */
export type ListOp =
  | { op: "put"; list: SavedList }
  | { op: "patch"; id: string; name?: string; checked?: string[] }
  | { op: "delete"; id: string };

export const MAX_SAVED_LISTS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validListId = (value: string) => UUID.test(value);

/** A new list id, chosen here so a list saved offline is stored once when it is sent. */
export function newListId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Add a change to the queue: changes to one list join, a deletion replaces what came before it. */
export function queueListOp(queue: readonly ListOp[], op: ListOp): ListOp[] {
  const id = op.op === "put" ? op.list.id : op.id;
  if (op.op === "delete") return [...queue.filter(item => (item.op === "put" ? item.list.id : item.id) !== id), op];
  if (op.op === "patch") {
    const index = queue.findIndex(item => item.op !== "delete" && (item.op === "put" ? item.list.id : item.id) === id);
    if (index >= 0) {
      const earlier = queue[index], next = [...queue];
      next[index] = earlier.op === "put"
        ? { op: "put", list: { ...earlier.list, ...(op.name !== undefined ? { name: op.name } : {}), ...(op.checked !== undefined ? { checked: op.checked } : {}) } }
        : { ...earlier, ...op } as ListOp;
      return next;
    }
  }
  return [...queue, op];
}

/** The lists as they will be once the queued changes are applied, the most recent first. */
export function applyListOps(lists: readonly SavedList[], ops: readonly ListOp[]): SavedList[] {
  let result = [...lists];
  for (const op of ops) {
    if (op.op === "put") result = [op.list, ...result.filter(list => list.id !== op.list.id)];
    else if (op.op === "delete") result = result.filter(list => list.id !== op.id);
    else result = result.map(list => list.id !== op.id ? list
      : { ...list, ...(op.name !== undefined ? { name: op.name } : {}), ...(op.checked !== undefined ? { checked: op.checked } : {}) });
  }
  return result.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function lineCount(list: Pick<SavedList, "content">): number {
  return list.content.sections.reduce((total, section) => total + section.lines.length, 0);
}

/** Copies kept in this browser, for offline use. The keys end with the account id (removed with its local data). */
export const listsKey = (userId: number) => `v2:basket:lists:${userId}`;
export const listsQueueKey = (userId: number) => `v2:basket:lists-queue:${userId}`;
function plausible(value: unknown): value is SavedList {
  const list = value as SavedList;
  return !!list && typeof list === "object" && typeof list.id === "string" && validListId(list.id) && typeof list.name === "string"
    && !!list.content && Array.isArray(list.content.sections) && Array.isArray(list.checked) && typeof list.updated_at === "string";
}
export function readLists(userId: number | null): { lists: SavedList[]; queue: ListOp[] } {
  if (!userId) return { lists: [], queue: [] };
  let lists: SavedList[] = [], queue: ListOp[] = [];
  try { const value: unknown = JSON.parse(localStorage.getItem(listsKey(userId)) ?? "[]"); if (Array.isArray(value)) lists = value.filter(plausible).slice(0, MAX_SAVED_LISTS); }
  catch { /* no copy */ }
  try {
    const value: unknown = JSON.parse(localStorage.getItem(listsQueueKey(userId)) ?? "[]");
    if (Array.isArray(value)) queue = value.filter((op): op is ListOp => !!op && typeof op === "object"
      && ((op.op === "put" && plausible(op.list)) || ((op.op === "patch" || op.op === "delete") && typeof op.id === "string" && validListId(op.id)))).slice(0, 200);
  } catch { /* nothing waiting */ }
  return { lists, queue };
}
export function writeLists(userId: number, lists: readonly SavedList[]) {
  try { localStorage.setItem(listsKey(userId), JSON.stringify(lists)); } catch { /* the lists still work on this page */ }
}
export function writeListsQueue(userId: number, queue: readonly ListOp[]) {
  try { if (queue.length) localStorage.setItem(listsQueueKey(userId), JSON.stringify(queue)); else localStorage.removeItem(listsQueueKey(userId)); }
  catch { /* the changes are still sent from this page */ }
}

/** A default name for a new list: the day it is saved. */
export function defaultListName(date: Date, storeName?: string | null): string {
  const day = date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  return (storeName ? `${storeName} · ` : "Courses du ") + day;
}
