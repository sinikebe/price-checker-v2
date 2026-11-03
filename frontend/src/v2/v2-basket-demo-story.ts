/**
 * The figures of the demo story on the home page, computed from the demo basket by the basket comparison
 * itself, with the demo's own settings: the same numbers as the demo page shows when it opens.
 */
import { buildBasketComparison, purchaseTotalCents, reactivationGains, readingKey, type BasketPrice, type CompareMode, type UnitChoices } from "./v2-basket-comparison";
import { snapshotView } from "./v2-basket-snapshot";
import { basketItemKey, type BasketItem, type BasketQuantity } from "./v2-basket-storage";
import { demoItems, initialDemoState, type DemoSource } from "./v2-basket-demo";
import { splitList, type ListSection } from "./v2-shopping-list";

type Store = { key: string; retailer: string; place: string; drive: boolean; cents: number; count: number };
export type DemoStory = {
  title: string; fictional: boolean; savedAt: string | null; advanced: boolean; mode: CompareMode;
  articles: { key: string; name: string; group: boolean; quantity: string | null }[];
  /** A group of the basket, to say what a group compares. */
  firstGroup: string | null;
  /** Every store and channel, complete baskets first. */
  ranking: (Store & { complete: boolean })[];
  /** The first store for the whole basket, when one has it all. */
  best: Store | null;
  /** The split across every store compared. */
  split: { cents: number; stores: Store[]; priced: number };
  /** A store the demo leaves out of the split, and what putting it back would bring. */
  left: (Store & { gainCents: number }) | null;
  /** The split the demo opens on, without the stores left out. */
  final: { cents: number; stores: Store[]; priced: number };
  /** The start of the list of the first store of that split. */
  list: { retailer: string; place: string; lines: string[]; more: number } | null;
};

const shortName = (item: BasketItem) => "kind" in item ? item.name : item.data.name;
/** What a chip shows: the group of a product ("Lait"), shorter than its name. */
const chipName = (item: BasketItem) => "kind" in item ? item.name : item.data.group?.trim() || item.data.name;
const place = (reading: BasketPrice) => reading.sales_channel === "drive" ? `Drive · ${reading.city ?? ""}`.trim()
  : reading.sales_channel === "delivery" ? `Livraison · ${reading.city ?? ""}`.trim() : reading.city ?? reading.store_name;
const decimal = (amount: string) => amount.replace(".", ",");
/** A short quantity for a chip: "2 kg", "×8", "24 pièces". */
function quantityLabel(quantity: BasketQuantity): string {
  if (quantity.unit === "package") return `×${decimal(quantity.amount)}`;
  if (quantity.unit === "piece") return `${decimal(quantity.amount)} pièce${Number(quantity.amount) > 1 ? "s" : ""}`;
  return `${decimal(quantity.amount)} ${quantity.unit === "l" ? "L" : quantity.unit}`;
}

/** The story of a demo, or null when it has nothing to compare. */
export function demoStory(source: DemoSource): DemoStory | null {
  const { advanced, compare: mode, filters, stores_off: storesOff, units } = source.settings;
  const items = demoItems(initialDemoState(source), source).filter(item => !item.disabled);
  const view = snapshotView(source.snapshot, items);
  if (!view.lines.length) return null;
  const unitChoices: UnitChoices = item => units[basketItemKey(item)];
  const build = (off: ReadonlySet<string>) => buildBasketComparison(view.lines, view.responses, filters, advanced, off, mode, unitChoices);
  const rows = [...view.responses.values()].flatMap(response => response?.latest_by_store ?? []);
  const off = new Set(storesOff.filter(key => rows.some(row => readingKey(row) === key)));
  const all = build(new Set());
  const final = off.size ? build(off) : all;
  if (!all.split.length) return null;
  const store = (section: ListSection): Store => ({
    key: section.key, retailer: section.reading.retailer, place: place(section.reading), drive: section.reading.sales_channel === "drive",
    cents: purchaseTotalCents(section.lines.flatMap(line => line.choice ? [line.choice] : []), advanced), count: section.lines.length,
  });
  const lines = view.lines.map(line => line.item);
  const sections = (comparison: typeof all) => splitList(comparison, lines, basketItemKey).sections;
  const splitStores = sections(all).map(store);
  const finalSections = sections(final);
  const ranking = all.stores.map(quote => ({
    key: quote.key, retailer: quote.reading.retailer, place: place(quote.reading), drive: quote.reading.sales_channel === "drive",
    cents: quote.cents, count: quote.coverage, complete: quote.coverage === lines.length,
  }));
  const gains = off.size ? reactivationGains(view.lines, view.responses, filters, advanced, final, off, mode, unitChoices) : new Map();
  const leftKey = [...off].find(key => gains.get(key)?.unpriced === 0);
  const leftReading = leftKey ? rows.find(row => readingKey(row) === leftKey) : undefined;
  const first = finalSections[0];
  return {
    title: source.title, fictional: source.fictional, savedAt: source.savedAt, advanced, mode,
    articles: items.map(item => ({ key: basketItemKey(item), name: chipName(item), group: "kind" in item,
      quantity: advanced && item.quantity ? quantityLabel(item.quantity) : null })),
    firstGroup: items.find(item => "kind" in item && item.kind === "group")?.name ?? null,
    ranking,
    best: ranking[0]?.complete ? ranking[0] : null,
    split: { cents: all.splitCents, stores: splitStores, priced: all.split.length },
    left: leftKey && leftReading ? {
      ...(splitStores.find(candidate => candidate.key === leftKey) ?? {
        key: leftKey, retailer: leftReading.retailer, place: place(leftReading), drive: leftReading.sales_channel === "drive", cents: 0, count: 0,
      }),
      gainCents: gains.get(leftKey)?.extraCents ?? 0,
    } : null,
    final: { cents: final.splitCents, stores: finalSections.map(store), priced: final.split.length },
    list: first ? { retailer: first.reading.retailer, place: place(first.reading), lines: first.lines.slice(0, 3).map(line => shortName(line.item)),
      more: Math.max(0, first.lines.length - 3) } : null,
  };
}

const stories = new WeakMap<DemoSource, DemoStory | null>();
/** The story of a demo, computed once. */
export function demoStoryOf(source: DemoSource): DemoStory | null {
  if (!stories.has(source)) stories.set(source, demoStory(source));
  return stories.get(source) ?? null;
}
