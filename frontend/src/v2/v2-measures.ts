import type { BaseUnit } from "./v2-basket-quantity";

/** The units a pack can be measured in: weight, volume, or a count of pieces. */
export const MEASURE_UNITS: readonly BaseUnit[] = ["g", "ml", "piece"];

export const measureUnitLabel = (unit: BaseUnit, amount = 2): string =>
  unit === "piece" ? (amount === 1 ? "pièce" : "pièces") : unit;

/** "500 g", "4 pièces": an amount as the server writes it ("500.000") without its trailing zeros. */
export function formatMeasure(measure: { amount: string; unit: BaseUnit }): string {
  const amount = Number(measure.amount);
  const text = Number.isFinite(amount) ? String(amount).replace(".", ",") : measure.amount;
  return `${text} ${measureUnitLabel(measure.unit, amount)}`;
}

/**
 * The amount typed for an extra unit of a pack, as the text the server takes, or null when it is not one:
 * positive, below a billion, three decimals at most, and a whole number for pieces.
 */
export function readExtraAmount(text: string, unit: BaseUnit): string | null {
  const value = text.trim().replace(",", ".");
  if (!/^\d{1,9}(?:\.\d{1,3})?$/.test(value)) return null;
  const amount = Number(value);
  if (!(amount > 0) || (unit === "piece" && !Number.isInteger(amount))) return null;
  return String(amount);
}

/** The unit chosen for each article of the basket (by its key) when it can be compared in several. */
export type UnitChoiceMap = Record<string, BaseUnit>;
const MAX_CHOICES = 100;
const isUnit = (value: unknown): value is BaseUnit => value === "g" || value === "ml" || value === "piece";

export function parseUnitChoices(raw: unknown): UnitChoiceMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const choices: UnitChoiceMap = {};
  for (const [key, unit] of Object.entries(raw)) {
    if (Object.keys(choices).length >= MAX_CHOICES) break;
    if (key.length > 0 && key.length <= 400 && isUnit(unit)) choices[key] = unit;
  }
  return choices;
}

const storageKey = (userId: number | null) => `v2:basket:units:${userId ?? "anonymous"}`;
export function readUnitChoices(userId: number | null): UnitChoiceMap {
  try { return parseUnitChoices(JSON.parse(localStorage.getItem(storageKey(userId)) ?? "{}")); } catch { return {}; }
}
export function writeUnitChoices(userId: number | null, choices: UnitChoiceMap): void {
  try { localStorage.setItem(storageKey(userId), JSON.stringify(choices)); } catch { /* the current tab still works */ }
}

/** The choices with one article's unit set (or cleared with null); choices of articles no longer in `keep` are dropped. */
export function withUnitChoice(choices: UnitChoiceMap, key: string, unit: BaseUnit | null, keep: Iterable<string>): UnitChoiceMap {
  const kept = new Set(keep);
  const next: UnitChoiceMap = {};
  for (const [itemKey, chosen] of Object.entries(choices)) if (kept.has(itemKey) && itemKey !== key) next[itemKey] = chosen;
  if (unit && kept.has(key)) next[key] = unit;
  return next;
}
