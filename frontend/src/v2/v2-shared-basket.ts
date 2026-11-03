/**
 * Shared baskets, without React: the server's lines as basket items, and a member's edits as
 * changes. No value import, so the tests can load this file on its own.
 */
import type { BasketFilters, CompareMode } from "./v2-basket-comparison";
import type { BaseUnit } from "./v2-basket-quantity";
import type { BasketItem, BasketQuantity } from "./v2-basket-storage";
import type { ProductData } from "./v2-products-api";

export type SharedLine = {
  id: number; kind: "product" | "group" | "scope"; label: string; product_id: number | null;
  department: string | null; family: string | null;
  quantity: BasketQuantity | null; disabled: boolean;
  added_by: string | null; mine: boolean; created_at: string;
  product: { id: number; revision: number; data: ProductData } | null;
};
export type SharedMember = { id: number; username: string; owner: boolean };
export type SharedBasket = {
  id: number; name: string; revision: number; role: "owner" | "member"; owner: string | null;
  invite: string; members: SharedMember[]; lines: SharedLine[]; limits: { lines: number; members: number };
  /** Absent from the first servers with shared baskets: read with sharedSettings(). */
  settings?: Partial<SharedSettings>;
};
export type SharedSummary = {
  id: number; name: string; owner: boolean; owner_name: string; updated_at: string; lines: number; members: number;
};
export type InvitePreview = { id: number; name: string; owner: string; lines: number; members: number; member: boolean };

export type LineRef =
  | { kind: "product"; product_id: number }
  | { kind: "group"; name: string }
  | { kind: "scope"; department: string; family: string; name: string };
/** A change as the browser keeps it until the server confirms it: an addition carries its item to show it meanwhile. */
/** How every member sees a shared basket: the same filters and options, kept on the server. */
export type SharedSettings = {
  advanced: boolean; compare: CompareMode; filters: BasketFilters;
  stores_off: string[]; units: Record<string, BaseUnit>;
  /** Articles ticked in the shopping list (basket keys). */
  checked: string[];
};
export const DEFAULT_SETTINGS: SharedSettings = {
  advanced: false, compare: "price", filters: { storeIds: [], cities: [], departments: [] }, stores_off: [], units: {}, checked: [],
};
export type LocalOp =
  | { op: "settings"; patch: Partial<SharedSettings> }
  | { op: "add"; line: LineRef; quantity: BasketQuantity | null; disabled: boolean; item: BasketItem }
  | { op: "remove"; line: LineRef; key: string }
  | { op: "update"; line: LineRef; key: string; quantity?: BasketQuantity | null; disabled?: boolean };
export type WireOp =
  | ({ op: "settings" } & Partial<SharedSettings>)
  | { op: "add"; line: LineRef; quantity: BasketQuantity | null; disabled: boolean }
  | { op: "remove"; line: LineRef }
  | { op: "update"; line: LineRef; quantity?: BasketQuantity | null; disabled?: boolean };
type KeyOf = (item: BasketItem) => string;

export const SHARED_INVITE = /^#rejoindre=([1-9][0-9]{0,18}-[A-Za-z0-9_-]{22})$/;
export const MAX_OPS = 150;

/** The invitation carried by a link (`#rejoindre=…`), or null. */
export function inviteFromHash(hash: string): string | null {
  return SHARED_INVITE.exec(hash)?.[1] ?? null;
}

function options(line: SharedLine): { quantity?: BasketQuantity; disabled?: boolean } {
  return { ...(line.quantity ? { quantity: line.quantity } : {}), ...(line.disabled ? { disabled: true } : {}) };
}

/** The lines as basket items, in order. A product withdrawn since it was added cannot be priced: it is set apart. */
export function sharedItems(lines: readonly SharedLine[]): { items: BasketItem[]; lines: SharedLine[]; unavailable: SharedLine[] } {
  const items: BasketItem[] = [], kept: SharedLine[] = [], unavailable: SharedLine[] = [];
  for (const line of lines) {
    let item: BasketItem | null = null;
    if (line.kind === "product") item = line.product ? { id: line.product.id, data: line.product.data, revision: line.product.revision, ...options(line) } : null;
    else if (line.kind === "group") item = { kind: "group", name: line.label, ...options(line) };
    else if (line.department && line.family) item = { kind: "scope", name: line.label, department: line.department, family: line.family, ...options(line) };
    if (item) { items.push(item); kept.push(line); } else unavailable.push(line);
  }
  return { items, lines: kept, unavailable };
}

export function lineRef(item: BasketItem): LineRef {
  if (!("kind" in item)) return { kind: "product", product_id: item.id };
  return item.kind === "group" ? { kind: "group", name: item.name } : { kind: "scope", department: item.department, family: item.family, name: item.name };
}

const sameQuantity = (a: BasketQuantity | undefined, b: BasketQuantity | undefined) =>
  (!a && !b) || (!!a && !!b && a.amount === b.amount && a.unit === b.unit);

/** What turns the basket `current` into `next`: removals first, then additions and updates, in basket order. */
export function diffOps(current: readonly BasketItem[], next: readonly BasketItem[], keyOf: KeyOf): LocalOp[] {
  const before = new Map(current.map(item => [keyOf(item), item]));
  const after = new Set(next.map(keyOf));
  const ops: LocalOp[] = [];
  for (const [key, item] of before) if (!after.has(key)) ops.push({ op: "remove", line: lineRef(item), key });
  for (const item of next) {
    const key = keyOf(item), old = before.get(key);
    if (!old) { ops.push({ op: "add", line: lineRef(item), quantity: item.quantity ?? null, disabled: !!item.disabled, item }); continue; }
    const update: LocalOp = { op: "update", line: lineRef(item), key };
    if (!sameQuantity(old.quantity, item.quantity)) update.quantity = item.quantity ?? null;
    if (!!old.disabled !== !!item.disabled) update.disabled = !!item.disabled;
    if ("quantity" in update || "disabled" in update) ops.push(update);
  }
  return ops;
}

/** The basket as it will be once these changes are applied: what the member sees before the server answers. */
export function applyOps(items: readonly BasketItem[], ops: readonly LocalOp[], keyOf: KeyOf): BasketItem[] {
  let result = [...items];
  for (const op of ops) {
    if (op.op === "settings") continue;
    if (op.op === "add") {
      const key = keyOf(op.item);
      if (!result.some(item => keyOf(item) === key)) result.push(op.item);
    } else if (op.op === "remove") result = result.filter(item => keyOf(item) !== op.key);
    else result = result.map(item => {
      if (keyOf(item) !== op.key) return item;
      const changed: BasketItem = { ...item };
      if ("quantity" in op) { if (op.quantity) changed.quantity = op.quantity; else delete changed.quantity; }
      if ("disabled" in op) { if (op.disabled) changed.disabled = true; else delete changed.disabled; }
      return changed;
    });
  }
  return result;
}

export function wireOps(ops: readonly LocalOp[]): WireOp[] {
  return ops.map(op => op.op === "settings" ? { op: "settings", ...op.patch } : op.op === "add" ? { op: "add", line: op.line, quantity: op.quantity, disabled: op.disabled }
    : op.op === "remove" ? { op: "remove", line: op.line }
      : { op: "update", line: op.line, ...("quantity" in op ? { quantity: op.quantity } : {}), ...("disabled" in op ? { disabled: op.disabled } : {}) });
}

/** What another member just added, for a short notice: lines that are new and not this account's. */
export function newFromOthers(previous: readonly SharedLine[] | null, next: readonly SharedLine[]): SharedLine[] {
  if (!previous) return [];
  const known = new Set(previous.map(line => line.id));
  return next.filter(line => !known.has(line.id) && !line.mine);
}

export function activityText(lines: readonly SharedLine[]): string {
  if (!lines.length) return "";
  const who = [...new Set(lines.map(line => line.added_by ?? "Un membre"))];
  const names = lines.slice(0, 3).map(line => line.label).join(", ") + (lines.length > 3 ? ` et ${lines.length - 3} autre${lines.length > 4 ? "s" : ""}` : "");
  return `${who.length === 1 ? `${who[0]} a` : "Des membres ont"} ajouté ${names}.`;
}

/** Where the active shared basket of an account is remembered in this browser. */
export const sharedKey = (userId: number) => `v2:basket:shared:${userId}`;
export function readSharedId(userId: number | null): number | null {
  if (!userId) return null;
  try { const value = Number(localStorage.getItem(sharedKey(userId))); return Number.isSafeInteger(value) && value > 0 ? value : null; }
  catch { return null; }
}
export function writeSharedId(userId: number, basketId: number | null) {
  try { if (basketId) localStorage.setItem(sharedKey(userId), String(basketId)); else localStorage.removeItem(sharedKey(userId)); }
  catch { /* the choice lasts for this page only */ }
}

/** The page of the shared basket; the personal basket stays at /v2/panier. */
export const SHARED_BASKET_PATH = "/v2/panier/partage";
export const inviteUrl = (origin: string, invite: string) => `${origin}${SHARED_BASKET_PATH}#rejoindre=${invite}`;

export const STORAGE_NOTICE = "Un panier partagé est enregistré sur le serveur, jusqu’à ce que son créateur le supprime ou supprime son compte. "
  + "Les membres invités voient et modifient ses articles en direct ; chacun utilise ses propres crédits pour en voir les prix.";

const PENDING_INVITE = "v2:basket:pending-invite";
/** An invitation kept while the visitor signs in, so the link still works afterwards (this tab only). */
export function keepPendingInvite(invite: string) {
  try { sessionStorage.setItem(PENDING_INVITE, invite); } catch { /* the link can be opened again */ }
}
export function takePendingInvite(): string | null {
  try {
    const value = sessionStorage.getItem(PENDING_INVITE);
    sessionStorage.removeItem(PENDING_INVITE);
    return value && SHARED_INVITE.test("#rejoindre=" + value) ? value : null;
  } catch { return null; }
}

/** The settings of a shared basket, with the defaults for what the server does not say. */
export function sharedSettings(basket: Pick<SharedBasket, "settings"> | null): SharedSettings {
  const stored = basket?.settings ?? {};
  return { ...DEFAULT_SETTINGS, ...stored, filters: { ...DEFAULT_SETTINGS.filters, ...(stored.filters ?? {}) } };
}

/** The settings as they will be once these changes are applied (later changes win). */
export function applySettings(settings: SharedSettings, ops: readonly LocalOp[]): SharedSettings {
  let result = settings;
  for (const op of ops) if (op.op === "settings") result = { ...result, ...op.patch };
  return result;
}

/** A settings change queued after another one not sent yet joins it: one request instead of several. */
export function queueOps(queue: readonly LocalOp[], ops: readonly LocalOp[]): LocalOp[] {
  const result = [...queue];
  for (const op of ops) {
    const last = result[result.length - 1];
    if (op.op === "settings" && last?.op === "settings") result[result.length - 1] = { op: "settings", patch: { ...last.patch, ...op.patch } };
    else result.push(op);
  }
  return result;
}
