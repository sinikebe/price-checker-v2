/**
 * The demo basket shown on the home page and at /v2/panier/demo, from one of two sources: the app's own
 * example (a month of groceries, eighteen articles and their quantities, in four fictional stores, priced
 * here from today), or the basket an administrator saved with the prices the server read then (read from
 * GET /api/v2/demo-basket and checked by savedDemo). Either way the basket comparison runs on these prices
 * as it does on fetched ones, and what the visitor changes is kept in this tab only (session storage).
 */
import { basketItemKey, validBasketQuantity, validSelection, type BasketItem, type BasketProduct, type BasketQuantity } from "./v2-basket-storage";
import type { BasketPrice, BasketPriceResponse } from "./v2-basket-comparison";
import type { BasketSnapshot } from "./v2-basket-snapshot";
import type { SharedSettings } from "./v2-shared-basket";
import type { MeasureUnit, ProductData } from "./v2-products-api";
import type { ConfirmOptions } from "./useConfirm";

export const DEMO_BASKET_PATH = "/v2/panier/demo";

type Store = { id: number; retailer: string; store_name: string; city: string; postal_code: string };
const HORIZON: Store = { id: 9101, retailer: "Horizon", store_name: "Hyper Horizon Gratte-Ciel", city: "Villeurbanne", postal_code: "69100" };
const LUMIERE: Store = { id: 9102, retailer: "Marché Lumière", store_name: "Marché Lumière Part-Dieu", city: "Lyon", postal_code: "69003" };
const COMPTOIR: Store = { id: 9103, retailer: "Comptoir Frais", store_name: "Comptoir Frais Jean-Macé", city: "Lyon", postal_code: "69007" };
const CABAS: Store = { id: 9104, retailer: "Cabas Discount", store_name: "Cabas Discount Miribel", city: "Miribel", postal_code: "01700" };
const OUTLETS = {
  H: [HORIZON, "in_store"], HD: [HORIZON, "drive"], L: [LUMIERE, "in_store"], C: [COMPTOIR, "in_store"], D: [CABAS, "in_store"],
} as const satisfies Record<string, readonly [Store, BasketPrice["sales_channel"]]>;
type Outlet = keyof typeof OUTLETS;

/** The store the demo leaves out of the split at first: the one that saves the least, as in the story of the home page. */
export const DEMO_STORE_OFF = `${COMPTOIR.id}:in_store`;

type Spec = {
  id: number; brand: string; name: string; group: string; quantity: string;
  measures: [amount: string, unit: MeasureUnit, noun?: string][];
  /** Price in euros and age in days, per store and channel. */
  prices: Partial<Record<Outlet, [price: string, days: number]>>;
};
const PRODUCTS: Spec[] = [
  { id: 9201, brand: "Moulin Vert", name: "Spaghetti", group: "Pâtes", quantity: "500 g", measures: [["500", "g"]],
    prices: { H: ["0.95", 4], HD: ["0.95", 2], L: ["1.15", 26], D: ["0.69", 6] } },
  { id: 9202, brand: "Moulin Vert", name: "Penne rigate", group: "Pâtes", quantity: "1 kg", measures: [["1000", "g"]],
    prices: { H: ["1.69", 4], HD: ["1.65", 2], L: ["1.99", 26], D: ["1.29", 6] } },
  { id: 9203, brand: "Moulin Vert", name: "Fusilli complètes", group: "Pâtes", quantity: "500 g", measures: [["500", "g"]],
    prices: { H: ["1.25", 5], HD: ["1.25", 2], L: ["1.39", 33], C: ["1.79", 9] } },
  { id: 9204, brand: "Prairie Douce", name: "Lait demi-écrémé", group: "Lait", quantity: "1 L", measures: [["1000", "ml"]],
    prices: { H: ["1.09", 4], HD: ["1.05", 2], L: ["1.24", 26], C: ["1.32", 9], D: ["0.89", 6] } },
  { id: 9205, brand: "Ferme des Collines", name: "Œufs plein air", group: "Œufs", quantity: "6 œufs", measures: [["6", "piece", "œufs"]],
    prices: { H: ["2.19", 4], HD: ["2.15", 2], L: ["2.49", 26], C: ["1.99", 9], D: ["1.69", 6] } },
  { id: 9206, brand: "Ferme des Collines", name: "Œufs plein air", group: "Œufs", quantity: "12 œufs", measures: [["12", "piece", "œufs"]],
    prices: { H: ["3.89", 4], HD: ["3.79", 2], L: ["4.39", 26], C: ["3.49", 9] } },
  { id: 9207, brand: "Arôme Doré", name: "Café moulu pur arabica", group: "Café moulu", quantity: "250 g", measures: [["250", "g"]],
    prices: { H: ["3.69", 5], HD: ["3.39", 3], L: ["3.99", 47], C: ["4.29", 12] } },
  { id: 9208, brand: "Vergers du Val", name: "Pommes Gala", group: "Pommes", quantity: "1 kg (6 pommes)", measures: [["1000", "g"], ["6", "piece", "pommes"]],
    prices: { H: ["2.79", 4], HD: ["2.79", 2], L: ["3.29", 26], C: ["2.49", 9] } },
  { id: 9209, brand: "Vergers du Val", name: "Pommes Golden", group: "Pommes", quantity: "4 pommes (700 g)", measures: [["4", "piece", "pommes"], ["700", "g"]],
    prices: { H: ["2.29", 4], HD: ["2.25", 2], L: ["2.59", 26], C: ["1.89", 9] } },
  { id: 9210, brand: "Laiterie du Val", name: "Beurre doux", group: "Beurre", quantity: "250 g", measures: [["250", "g"]],
    prices: { H: ["2.39", 4], HD: ["2.35", 2], L: ["2.69", 26], C: ["2.89", 9], D: ["1.95", 6] } },
  { id: 9211, brand: "Prairie Douce", name: "Yaourts nature", group: "Yaourts nature", quantity: "8 × 125 g", measures: [["1000", "g"], ["8", "piece", "pots"]],
    prices: { H: ["2.55", 4], HD: ["2.49", 2], L: ["2.95", 26], C: ["3.15", 9], D: ["1.99", 6] } },
  { id: 9212, brand: "Moulin Vert", name: "Riz basmati", group: "Riz basmati", quantity: "500 g", measures: [["500", "g"]],
    prices: { H: ["1.59", 4], HD: ["1.55", 2], L: ["1.85", 40], D: ["1.19", 6] } },
  { id: 9213, brand: "Moulin Vert", name: "Riz basmati", group: "Riz basmati", quantity: "1 kg", measures: [["1000", "g"]],
    prices: { H: ["2.69", 4], HD: ["2.59", 2], L: ["3.09", 40], D: ["2.09", 6] } },
  { id: 9214, brand: "Oliveraie du Sud", name: "Huile d’olive vierge extra", group: "Huile d’olive", quantity: "75 cl", measures: [["750", "ml"]],
    prices: { H: ["7.79", 5], HD: ["7.29", 3], L: ["8.20", 118], C: ["8.90", 12] } },
  { id: 9215, brand: "Vergers du Val", name: "Tomates rondes", group: "Tomates", quantity: "1 kg", measures: [["1000", "g"]],
    prices: { H: ["2.99", 3], HD: ["2.99", 2], L: ["3.49", 26], C: ["2.79", 8] } },
  { id: 9216, brand: "Vergers du Val", name: "Tomates grappe", group: "Tomates", quantity: "500 g", measures: [["500", "g"]],
    prices: { H: ["1.99", 3], HD: ["1.95", 2], L: ["2.29", 26], C: ["1.69", 8], D: ["1.59", 6] } },
  { id: 9217, brand: "Fromagerie des Monts", name: "Emmental râpé", group: "Emmental râpé", quantity: "200 g", measures: [["200", "g"]],
    prices: { H: ["2.05", 4], HD: ["1.99", 2], L: ["2.29", 26], C: ["2.45", 9], D: ["1.59", 6] } },
  { id: 9218, brand: "Maison Tilleul", name: "Jambon blanc", group: "Jambon blanc", quantity: "4 tranches (160 g)", measures: [["4", "piece", "tranches"], ["160", "g"]],
    prices: { H: ["2.59", 4], HD: ["2.49", 2], L: ["2.89", 26], C: ["3.20", 9], D: ["1.99", 6] } },
  { id: 9219, brand: "Fournil Doré", name: "Pain de mie complet", group: "Pain de mie", quantity: "500 g", measures: [["500", "g"]],
    prices: { H: ["1.55", 4], HD: ["1.49", 2], L: ["1.79", 26], C: ["2.10", 9], D: ["1.15", 6] } },
  { id: 9220, brand: "Moulin Vert", name: "Muesli aux fruits", group: "Muesli", quantity: "750 g", measures: [["750", "g"]],
    prices: { H: ["3.19", 5], HD: ["2.99", 3], L: ["3.49", 47], C: ["3.95", 12] } },
  { id: 9221, brand: "Clos des Agrumes", name: "Jus d’orange pur jus", group: "Jus d’orange", quantity: "1 L", measures: [["1000", "ml"]],
    prices: { H: ["1.59", 4], HD: ["1.55", 2], L: ["1.85", 26], C: ["2.20", 9], D: ["1.19", 6] } },
  { id: 9222, brand: "Clair Lavande", name: "Lessive liquide", group: "Lessive", quantity: "1,5 L (30 lavages)", measures: [["1500", "ml"]],
    prices: { H: ["6.49", 5], HD: ["6.29", 3], L: ["6.99", 40], D: ["4.99", 6] } },
  { id: 9223, brand: "Clair Lavande", name: "Lessive liquide", group: "Lessive", quantity: "3 L (60 lavages)", measures: [["3000", "ml"]],
    prices: { H: ["11.49", 5], HD: ["10.99", 3], L: ["12.49", 40] } },
  { id: 9224, brand: "Douceur Coton", name: "Papier toilette", group: "Papier toilette", quantity: "12 rouleaux", measures: [["12", "piece", "rouleaux"]],
    prices: { H: ["5.79", 5], HD: ["5.49", 3], L: ["6.29", 40], D: ["4.29", 6] } },
  { id: 9225, brand: "Vergers du Val", name: "Carottes", group: "Carottes", quantity: "1 kg", measures: [["1000", "g"]],
    prices: { H: ["1.39", 3], HD: ["1.35", 2], L: ["1.69", 26], C: ["1.29", 8], D: ["1.09", 6] } },
];

function productData(spec: Spec): ProductData {
  const [first] = spec.measures;
  return {
    name: spec.name, brand: spec.brand, commercial_name: "", composition: "", package: "", quantity: spec.quantity, ean: "",
    group: spec.group, tags: [], retailer_links: [], notes: "", nutrition_checked_at: null,
    quantity_amount: first[0], quantity_unit: first[1], quantity_count_noun: first[2] ?? null, extra_quantities: [],
    measures: spec.measures.map(([amount, unit, noun]) => ({ amount, unit, count_noun: noun ?? null })),
    nutriscore: "", nova: "", nutriscore_version: "", off_source: null,
  };
}
const product = (id: number): BasketProduct => {
  const spec = PRODUCTS.find(candidate => candidate.id === id)!;
  return { id, revision: 1, data: productData(spec) };
};

/** The basket lines with their quantities for a month (the demo opens with "Quantités" on), and the products each one is compared on. */
const LINES: { item: BasketItem; candidates: number[] }[] = [
  { item: { kind: "group", name: "Pâtes", quantity: { amount: "1.5", unit: "kg" } }, candidates: [9201, 9202, 9203] },
  { item: { ...product(9204), quantity: { amount: "8", unit: "package" } }, candidates: [9204] },
  { item: { kind: "group", name: "Œufs", quantity: { amount: "24", unit: "piece" } }, candidates: [9205, 9206] },
  { item: { ...product(9207), quantity: { amount: "2", unit: "package" } }, candidates: [9207] },
  { item: { kind: "group", name: "Pommes", quantity: { amount: "2", unit: "kg" } }, candidates: [9208, 9209] },
  { item: { ...product(9210), quantity: { amount: "3", unit: "package" } }, candidates: [9210] },
  { item: { ...product(9211), quantity: { amount: "24", unit: "piece" } }, candidates: [9211] },
  { item: { kind: "group", name: "Riz basmati", quantity: { amount: "1.5", unit: "kg" } }, candidates: [9212, 9213] },
  { item: { ...product(9214), quantity: { amount: "1", unit: "package" } }, candidates: [9214] },
  { item: { kind: "group", name: "Tomates", quantity: { amount: "2", unit: "kg" } }, candidates: [9215, 9216] },
  { item: { ...product(9217), quantity: { amount: "3", unit: "package" } }, candidates: [9217] },
  { item: { ...product(9218), quantity: { amount: "3", unit: "package" } }, candidates: [9218] },
  { item: { ...product(9219), quantity: { amount: "3", unit: "package" } }, candidates: [9219] },
  { item: { ...product(9220), quantity: { amount: "2", unit: "package" } }, candidates: [9220] },
  { item: { ...product(9221), quantity: { amount: "4", unit: "package" } }, candidates: [9221] },
  { item: { kind: "group", name: "Lessive", quantity: { amount: "3", unit: "l" } }, candidates: [9222, 9223] },
  { item: { ...product(9224), quantity: { amount: "1", unit: "package" } }, candidates: [9224] },
  { item: { ...product(9225), quantity: { amount: "2", unit: "package" } }, candidates: [9225] },
];
const LINE_KEYS = LINES.map(line => basketItemKey(line.item));

function dayBefore(today: Date, days: number): string {
  return new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() - days)).toISOString().slice(0, 10);
}

/** The demo prices as a fetched result, dated from `today`: the basket page computes everything from it. */
function demoSnapshot(today: Date): BasketSnapshot {
  let rowId = 0;
  const products: BasketSnapshot["products"] = {};
  const prices: BasketSnapshot["prices"] = {};
  for (const spec of PRODUCTS) {
    products[spec.id] = product(spec.id);
    const rows = (Object.keys(spec.prices) as Outlet[]).map((outlet): BasketPrice => {
      const [store, channel] = OUTLETS[outlet];
      const [price, days] = spec.prices[outlet]!;
      return {
        id: ++rowId, price, observed_at: dayBefore(today, days), retailer: store.retailer, store_name: store.store_name,
        store_id: store.id, city: store.city, postal_code: store.postal_code, sales_channel: channel,
        available: true, correction_status: null, source_provider: null,
      };
    });
    prices[spec.id] = { latest_by_store: rows, stores_truncated: false, withdrawn_count: 0 } satisfies BasketPriceResponse;
  }
  const entries: BasketSnapshot["entries"] = {};
  LINES.forEach((line, index) => { entries[LINE_KEYS[index]] = { productIds: line.candidates, truncated: false }; });
  return { userId: 0, fetchedAt: today.toISOString(), entries, products, prices };
}

/**
 * Where a demo comes from. `fictional`: the app's example, with fictional stores, products and prices and
 * no catalogue pages. `savedAt`: when an administrator saved it (its prices were read then); null for the
 * app's example.
 */
export type DemoOrigin = { fictional: true; savedAt: null } | { fictional: false; savedAt: string };
/**
 * A demo basket: the app's own fictional example, or a basket an administrator saved with the prices
 * read at that moment. Either way the browser computes everything from `snapshot`.
 */
export type DemoSource = DemoOrigin & {
  /** Which demo this is: the app's example, or the moment an administrator saved one. */
  id: string;
  title: string;
  items: BasketItem[];
  settings: SharedSettings;
  snapshot: BasketSnapshot;
};
/** The day a demo was saved, as its notices write it ("3 novembre 2026"). */
export const demoDate = (value: string) => new Date(value).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
/** The dialog before an administrator goes back to the app's example, the same from every place that offers it. */
export const BUILTIN_DEMO_CONFIRM: ConfirmOptions = {
  title: "Revenir à l’exemple intégré",
  message: "Revenir à l’exemple intégré, avec des prix fictifs ? Le panier de démonstration enregistré sera effacé.",
  confirmLabel: "Revenir à l’exemple",
  danger: true,
};

const BUILTIN_SETTINGS: SharedSettings = {
  advanced: true, compare: "price", filters: { storeIds: [], cities: [], departments: [] },
  stores_off: [DEMO_STORE_OFF], units: {}, checked: [], list_mode: "split",
};

/** The app's own example: a month of groceries in four fictional stores, priced from `today`. */
export function builtinDemo(today: Date): DemoSource {
  return { id: "builtin", title: "Un mois de courses", fictional: true, savedAt: null,
    items: LINES.map(line => line.item), settings: BUILTIN_SETTINGS, snapshot: demoSnapshot(today) };
}

const STORE_KEY = /^[1-9][0-9]{0,18}:(?:in_store|drive|delivery)$/;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const list = <T>(value: unknown, keep: (item: unknown) => item is T, max = 100): T[] =>
  Array.isArray(value) ? [...new Set(value.filter(keep))].slice(0, max) : [];
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Settings read back from storage or from the server: anything unexpected takes the value of `start`. */
function normalizeSettings(value: unknown, start: SharedSettings): SharedSettings {
  const settings = record(value);
  const filters = record(settings.filters);
  return {
    advanced: typeof settings.advanced === "boolean" ? settings.advanced : start.advanced,
    compare: settings.compare === "unit" || settings.compare === "price" ? settings.compare : start.compare,
    filters: {
      storeIds: list(filters.storeIds, (id): id is number => Number.isSafeInteger(id) && (id as number) > 0),
      cities: list(filters.cities, (city): city is string => text(city, 120)),
      departments: list(filters.departments, (department): department is string => text(department, 3)),
    },
    stores_off: Array.isArray(settings.stores_off) ? list(settings.stores_off, (key): key is string => typeof key === "string" && STORE_KEY.test(key)) : start.stores_off,
    units: Object.fromEntries(Object.entries(record(settings.units))
      .filter(([key, unit]) => text(key, 400) && (unit === "g" || unit === "ml" || unit === "piece")).slice(0, 100)) as SharedSettings["units"],
    checked: list(settings.checked, (key): key is string => text(key, 400)),
    list_mode: text(settings.list_mode, 60) ? settings.list_mode : start.list_mode,
  };
}

function validItem(value: unknown): value is BasketItem {
  const item = record(value);
  if (item.kind === "group") return text(item.name, 100);
  if (item.kind === "scope") return text(item.name, 80) && text(item.department, 80) && text(item.family, 80);
  if (item.kind === "selection") return validSelection(item);
  return item.kind === undefined && Number.isSafeInteger(item.id) && (item.id as number) > 0 && Number.isSafeInteger(item.revision)
    && text(record(item.data).name, 400);
}

/** The demo an administrator saved, as the server sends it (`demo` of GET /api/v2/demo-basket), or null. */
export function savedDemo(value: unknown): DemoSource | null {
  const demo = record(value);
  const content = record(demo.content);
  const result = record(content.result);
  const items = Array.isArray(content.items) ? content.items : [];
  const lines = Array.isArray(result.lines) ? result.lines : [];
  if (!text(demo.title, 80) || !text(demo.saved_at, 40) || !text(result.fetched_at, 40) || !items.length || items.length > 100
    || lines.length !== items.length || !items.every(validItem)) return null;
  const entries: BasketSnapshot["entries"] = {};
  for (const [index, item] of items.entries()) {
    const line = record(lines[index]);
    const productIds = Array.isArray(line.product_ids) ? line.product_ids.filter((id): id is number => Number.isSafeInteger(id)) : [];
    entries[basketItemKey(item)] = { productIds, truncated: line.truncated === true };
  }
  if (Object.keys(entries).length !== items.length) return null;
  return {
    id: "saved:" + demo.saved_at, title: demo.title, fictional: false, savedAt: demo.saved_at,
    items: items.map(item => {
      const quantity = record(item).quantity;
      if (quantity === undefined || validBasketQuantity(quantity)) return item;
      const { quantity: _quantity, ...rest } = item;
      void _quantity;
      return rest as BasketItem;
    }),
    settings: { ...normalizeSettings(content.settings, BUILTIN_SETTINGS), checked: [] },
    snapshot: { userId: 0, fetchedAt: result.fetched_at, entries, products: record(result.products) as BasketSnapshot["products"],
      prices: record(result.prices) as BasketSnapshot["prices"] },
  };
}

/** What the visitor changed in a demo: the articles left (included or not, their quantity) and the settings. */
export type DemoLine = { key: string; disabled: boolean; quantity: BasketQuantity | null };
export type DemoState = { source: string; lines: DemoLine[]; settings: SharedSettings };

export function initialDemoState(source: DemoSource): DemoState {
  return {
    source: source.id,
    lines: source.items.map(item => ({ key: basketItemKey(item), disabled: item.disabled === true, quantity: item.quantity ?? null })),
    settings: source.settings,
  };
}

/** The basket items of a demo state, in the order of the demo. */
export function demoItems(state: DemoState, source: DemoSource): BasketItem[] {
  const byKey = new Map(source.items.map(item => [basketItemKey(item), item]));
  return state.lines.flatMap(line => {
    const known = byKey.get(line.key);
    if (!known) return [];
    const { quantity: _quantity, disabled: _disabled, ...item } = known;
    void _quantity; void _disabled;
    return [{ ...item, disabled: line.disabled, ...(line.quantity ? { quantity: line.quantity } : {}) } as BasketItem];
  });
}

/** A demo state read back from this tab: one for another demo, or anything unexpected, starts the demo again. */
export function normalizeDemoState(value: unknown, source: DemoSource): DemoState {
  const start = initialDemoState(source);
  const raw = record(value);
  if (raw.source !== source.id) return start;
  const keys = new Set(start.lines.map(line => line.key));
  const seen = new Set<string>();
  const lines = Array.isArray(raw.lines) ? raw.lines.flatMap((line): DemoLine[] => {
    const { key, disabled, quantity } = record(line);
    if (typeof key !== "string" || !keys.has(key) || seen.has(key)) return [];
    seen.add(key);
    return [{ key, disabled: disabled === true, quantity: validBasketQuantity(quantity) ? quantity : null }];
  }) : start.lines;
  return { source: source.id, lines, settings: normalizeSettings(raw.settings, start.settings) };
}

const STATE_KEY = "v2:basket:demo";
/** The demo as left in this tab (session storage: it ends with the tab and is never sent). */
export function readDemoState(source: DemoSource): DemoState {
  try { return normalizeDemoState(JSON.parse(sessionStorage.getItem(STATE_KEY) ?? "null"), source); } catch { return initialDemoState(source); }
}
export function writeDemoState(state: DemoState) {
  try { sessionStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* the demo still works in this page */ }
}
