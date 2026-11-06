/**
 * Shared baskets, without React: the server's lines as basket items, and a member's edits as
 * changes. No value import, so the tests can load this file on its own.
 */
import type { BasketFilters, CompareMode } from "./v2-basket-comparison";
import type { BaseUnit } from "./v2-basket-quantity";
import type { BasketItem, BasketProduct, BasketQuantity, SelectionMember } from "./v2-basket-storage";
import type { BasketPriceResponse } from "./v2-basket-comparison";
import type { BasketSnapshot } from "./v2-basket-snapshot";
import type { ProductData } from "./v2-products-api";

export type SharedLine = {
  id: number; kind: "product" | "group" | "scope" | "text" | "selection"; label: string; product_id: number | null;
  department: string | null; family: string | null;
  /** What a selection holds (its name is the label). */
  spec?: { include: SelectionMember[]; exclude?: SelectionMember[]; words?: string[] };
  quantity: BasketQuantity | null; disabled: boolean;
  /** Absent when the basket is seen through its link, without being a member. */
  added_by?: string | null; mine?: boolean; created_at: string;
  product: { id: number; revision: number; data: ProductData; off_reference?: boolean } | null;
};
export type SharedMember = { id: number; username: string; owner: boolean };
export type SharedBasket = {
  id: number; name: string; revision: number; role: "owner" | "member"; owner: string | null;
  /** Never kept in the browser copy (it lets anyone join): null until the server sends it. */
  invite: string | null; members: SharedMember[]; lines: SharedLine[]; limits: { lines: number; members: number };
  /** Absent from the first servers with shared baskets: read with sharedSettings(). */
  settings?: Partial<SharedSettings>;
  /** In the browser copy only: when the server last confirmed this state (ISO date). */
  synced_at?: string;
  /** When a member last fetched the basket's prices, and who (null: never). */
  prices?: { fetched_at: string; fetched_by?: string | null } | null;
};
/** The prices a member fetched for a shared basket, as the server keeps them for every member. */
export type SharedPrices = {
  fetched_at: string; fetched_by?: string | null;
  content: {
    fetched_at: string; line_ids: number[]; lines: { product_ids: number[]; truncated: boolean }[];
    products: Record<string, BasketProduct>; prices: Record<string, BasketPriceResponse>;
  };
};
/** A shared basket seen through its link, without an account: read only, no member's name. */
export type SharedView = {
  name: string; revision: number; settings: Partial<SharedSettings>; lines: SharedLine[]; prices: SharedPrices | null;
};
export type SharedSummary = {
  id: number; name: string; owner: boolean; owner_name: string; updated_at: string; lines: number; members: number;
};
export type InvitePreview = { id: number; name: string; owner: string; lines: number; members: number; member: boolean };

export type LineRef =
  | { kind: "product"; product_id: number; label?: string }
  | { kind: "group"; name: string }
  | { kind: "text"; name: string }
  | { kind: "scope"; department: string; family: string; name: string }
  | { kind: "selection"; name: string; include: SelectionMember[]; exclude: SelectionMember[]; words: string[] };
/** A change as the browser keeps it until the server confirms it: an addition carries its item to show it meanwhile. */
/** How every member sees a shared basket: the same filters and options, kept on the server. */
export type SharedSettings = {
  advanced: boolean; compare: CompareMode; filters: BasketFilters;
  stores_off: string[]; units: Record<string, BaseUnit>;
  /** Articles ticked in the shopping list (basket keys). */
  checked: string[];
  /** The list as every member sees it: "all", "split" or "store:<store>:<channel>". */
  list_mode: string;
};
export const DEFAULT_SETTINGS: SharedSettings = {
  advanced: false, compare: "price", filters: { storeIds: [], cities: [], departments: [] }, stores_off: [], units: {}, checked: [], list_mode: "all",
};
export type LocalOp =
  | { op: "settings"; patch: Partial<SharedSettings> }
  | { op: "add"; line: LineRef; quantity: BasketQuantity | null; disabled: boolean; item: BasketItem }
  | { op: "remove"; line: LineRef; key: string }
  | { op: "update"; line: LineRef; key: string; quantity?: BasketQuantity | null; disabled?: boolean }
  /** Tick or untick one article of the list: the only change allowed offline, sent when the connection is back. */
  | { op: "tick"; key: string; on: boolean };
export type WireOp =
  | ({ op: "settings" } & Partial<SharedSettings>)
  | { op: "add"; line: LineRef; quantity: BasketQuantity | null; disabled: boolean }
  | { op: "remove"; line: LineRef }
  | { op: "update"; line: LineRef; quantity?: BasketQuantity | null; disabled?: boolean }
  | { op: "tick"; key: string; on: boolean };
type KeyOf = (item: BasketItem) => string;

const SHARED_INVITE = /^#rejoindre=([1-9][0-9]{0,18}-[A-Za-z0-9_-]{22})$/;
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
    if (line.kind === "product") item = !line.product ? null : line.product.off_reference
      // Known only by its barcode: the name is the one the member who added it read from Open Food Facts.
      ? { id: line.product.id, data: { ...line.product.data, name: line.product.data.name || line.label }, revision: line.product.revision, off_reference: true, ...options(line) }
      : { id: line.product.id, data: line.product.data, revision: line.product.revision, ...options(line) };
    else if (line.kind === "group" || line.kind === "text") item = { kind: line.kind, name: line.label, ...options(line) };
    else if (line.kind === "selection") item = line.spec?.include?.length ? { kind: "selection", name: line.label, include: line.spec.include,
      exclude: line.spec.exclude ?? [], words: line.spec.words ?? [], ...options(line) } : null;
    else if (line.department && line.family) item = { kind: "scope", name: line.label, department: line.department, family: line.family, ...options(line) };
    if (item) { items.push(item); kept.push(line); } else unavailable.push(line);
  }
  return { items, lines: kept, unavailable };
}

export function lineRef(item: BasketItem): LineRef {
  if (!("kind" in item)) {
    const label = [item.data.brand, item.data.name].filter(Boolean).join(" ").slice(0, 200);
    return item.off_reference && label ? { kind: "product", product_id: item.id, label } : { kind: "product", product_id: item.id };
  }
  if (item.kind === "selection") return { kind: "selection", name: item.name, include: item.include, exclude: item.exclude ?? [], words: item.words ?? [] };
  return item.kind === "group" || item.kind === "text" ? { kind: item.kind, name: item.name }
    : { kind: "scope", department: item.department, family: item.family, name: item.name };
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
    if (op.op === "settings" || op.op === "tick") continue;
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
  return ops.map(op => op.op === "settings" ? { op: "settings", ...op.patch } : op.op === "tick" ? { op: "tick", key: op.key, on: op.on } : op.op === "add" ? { op: "add", line: op.line, quantity: op.quantity, disabled: op.disabled }
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
  + "Les membres invités voient et modifient ses articles en direct. Les prix récupérés par un membre, avec ses crédits, sont visibles de tous les membres "
  + "et de toute personne qui ouvre le lien du panier, sans dépenser de crédits.";

const PENDING_INVITE = "v2:basket:pending-invite";
/** This tab already looked for a shared basket of the account on the server (once per session). */
export const sharedLookedKey = (userId: number) => `v2:basket:shared-looked:${userId}`;
/** An invitation kept while the visitor signs in, so the link still works afterwards (this tab only). */
export function keepPendingInvite(invite: string) {
  try { sessionStorage.setItem(PENDING_INVITE, invite); } catch { /* the link can be opened again */ }
}
/** Drop the kept invitation; callers catch an unavailable storage. */
export function forgetPendingInvite() {
  sessionStorage.removeItem(PENDING_INVITE);
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
  for (const op of ops) {
    if (op.op === "settings") result = { ...result, ...op.patch };
    else if (op.op === "tick") {
      const others = result.checked.filter(key => key !== op.key);
      result = { ...result, checked: op.on ? [...others, op.key].slice(0, 100) : others };
    }
  }
  return result;
}

/** The ticks that turn `before` into `after`, one per article that changed. */
export function tickOps(before: readonly string[], after: readonly string[]): LocalOp[] {
  const was = new Set(before), now = new Set(after);
  return [...[...was].filter(key => !now.has(key)).map(key => ({ op: "tick" as const, key, on: false })),
    ...[...now].filter(key => !was.has(key)).map(key => ({ op: "tick" as const, key, on: true }))];
}

/** Offline, a shared basket only takes ticks: everything else waits for the connection. */
export const allowedOffline = (op: LocalOp) => op.op === "tick";

/**
 * A settings change queued after another one not sent yet joins it: one request instead of several. A
 * tick replaces a tick of the same article still waiting (the last one wins).
 */
export function queueOps(queue: readonly LocalOp[], ops: readonly LocalOp[]): LocalOp[] {
  let result = [...queue];
  for (const op of ops) {
    const last = result[result.length - 1];
    if (op.op === "settings" && last?.op === "settings") result[result.length - 1] = { op: "settings", patch: { ...last.patch, ...op.patch } };
    else if (op.op === "tick") result = [...result.filter(queued => !(queued.op === "tick" && queued.key === op.key)), op];
    else result.push(op);
  }
  return result;
}

/**
 * The last known state of a shared basket and the changes not sent yet, kept in this browser so the
 * basket opens offline (read only, ticks apart); the changes are sent when the connection is back. The keys end
 * with the account id, so they go with the account's local data.
 */
export const sharedStateKey = (basketId: number, userId: number) => `v2:basket:shared-state:${basketId}:${userId}`;
export const sharedQueueKey = (basketId: number, userId: number) => `v2:basket:shared-queue:${basketId}:${userId}`;
const OPS = new Set(["add", "remove", "update", "settings", "tick"]);
export function readSharedCache(basketId: number | null, userId: number | null): { basket: SharedBasket | null; queue: LocalOp[] } {
  if (!basketId || !userId) return { basket: null, queue: [] };
  let basket: SharedBasket | null = null, queue: LocalOp[] = [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(sharedStateKey(basketId, userId)) ?? "null");
    if (value && typeof value === "object" && (value as SharedBasket).id === basketId && Array.isArray((value as SharedBasket).lines)
      && Array.isArray((value as SharedBasket).members) && typeof (value as SharedBasket).revision === "number") basket = value as SharedBasket;
  } catch { /* no usable copy */ }
  try {
    const value: unknown = JSON.parse(localStorage.getItem(sharedQueueKey(basketId, userId)) ?? "[]");
    if (Array.isArray(value)) queue = value.filter((op): op is LocalOp => !!op && typeof op === "object" && OPS.has((op as LocalOp).op)).slice(0, 1000);
  } catch { /* nothing waiting */ }
  return { basket, queue };
}
/** Keep the state the server just confirmed, with the moment of that confirmation (shown offline). */
export function writeSharedState(userId: number, basket: SharedBasket, syncedAt: string) {
  // The invitation link grants membership: it is never written to the browser's storage.
  try { localStorage.setItem(sharedStateKey(basket.id, userId), JSON.stringify({ ...basket, invite: null, synced_at: syncedAt })); } catch { /* the page still works online */ }
}
export function writeSharedQueue(basketId: number, userId: number, ops: readonly LocalOp[]) {
  try {
    if (ops.length) localStorage.setItem(sharedQueueKey(basketId, userId), JSON.stringify(ops));
    else localStorage.removeItem(sharedQueueKey(basketId, userId));
  } catch { /* the changes are still sent from this page */ }
}
export function forgetSharedCache(basketId: number, userId: number) {
  try { localStorage.removeItem(sharedStateKey(basketId, userId)); localStorage.removeItem(sharedQueueKey(basketId, userId)); } catch { /* nothing kept */ }
}

/**
 * The prices of a shared basket as the basket page uses them: each priced line is matched to the
 * article it is now, so an article added or replaced since the fetch shows as not priced yet.
 */
export function sharedSnapshot(prices: SharedPrices, lines: readonly SharedLine[], keyOf: KeyOf, owner: { userId: number; basketId: number }): BasketSnapshot {
  const { items, lines: kept } = sharedItems(lines);
  const keyOfLine = new Map(kept.map((line, index) => [line.id, keyOf(items[index])]));
  const entries: BasketSnapshot["entries"] = {};
  prices.content.line_ids.forEach((id, index) => {
    const key = keyOfLine.get(id), line = prices.content.lines[index];
    if (key && line) entries[key] = { productIds: line.product_ids, truncated: line.truncated };
  });
  return { userId: owner.userId, basketId: owner.basketId, fetchedAt: prices.fetched_at, entries,
    products: prices.content.products, prices: prices.content.prices };
}

/** The shared prices kept in this browser for offline use (the key ends with the account id). */
export const sharedPricesKey = (basketId: number, userId: number) => `v2:basket:shared-prices:${basketId}:${userId}`;
export function readSharedPrices(basketId: number, userId: number): SharedPrices | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(sharedPricesKey(basketId, userId)) ?? "null");
    const prices = value as SharedPrices | null;
    return prices && typeof prices.fetched_at === "string" && prices.content && Array.isArray(prices.content.line_ids)
      && Array.isArray(prices.content.lines) && prices.content.products && prices.content.prices ? prices : null;
  } catch { return null; }
}
export function writeSharedPrices(basketId: number, userId: number, prices: SharedPrices) {
  try { localStorage.setItem(sharedPricesKey(basketId, userId), JSON.stringify(prices)); } catch { /* the page still shows them */ }
}
