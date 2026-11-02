import type { BasketQuantity, BasketItem, BasketProduct } from "./v2-basket-storage";

export type BaseUnit = "g" | "ml" | "piece";
const factors: Record<BasketQuantity["unit"], { unit: BaseUnit; factor: number } | null> = {
  g: { unit: "g", factor: 1 }, kg: { unit: "g", factor: 1000 },
  ml: { unit: "ml", factor: 1 }, cl: { unit: "ml", factor: 10 }, l: { unit: "ml", factor: 1000 },
  piece: { unit: "piece", factor: 1 }, package: null,
};

export function baseQuantity(quantity: BasketQuantity): { amount: number; unit: BaseUnit } | null {
  const factor = factors[quantity.unit];
  if (!factor) return null;
  return { amount: Number(quantity.amount) * factor.factor, unit: factor.unit };
}

type Size = { amount: number; unit: BaseUnit };
const isBaseUnit = (unit: unknown): unit is BaseUnit => unit === "g" || unit === "ml" || unit === "piece";

/**
 * Every size of one pack of a product, one per unit (grams, millilitres, pieces), main one first: the server's
 * `measures`, or the single quantity of a copy saved before they existed.
 */
export function productSizes(product: BasketProduct): Size[] {
  const listed = Array.isArray(product.data.measures) ? product.data.measures : [];
  const raw = listed.length ? listed : [{ amount: product.data.quantity_amount, unit: product.data.quantity_unit }];
  const sizes: Size[] = [];
  for (const item of raw) {
    const amount = Number(item.amount);
    if (Number.isFinite(amount) && amount > 0 && isBaseUnit(item.unit) && !sizes.some(size => size.unit === item.unit))
      sizes.push({ amount, unit: item.unit });
  }
  return sizes;
}
/** The main size of one pack of a product, in grams, millilitres or pieces, when the catalogue knows it. */
export const productSize = (product: BasketProduct): Size | null => productSizes(product)[0] ?? null;
/** The size of one pack in a given unit, when the catalogue knows it. */
export const productSizeIn = (product: BasketProduct, unit: BaseUnit): Size | null =>
  productSizes(product).find(size => size.unit === unit) ?? null;
/** The amount of one pack in a given unit as written by the server (decimal text), for exact arithmetic. */
function measureText(product: BasketProduct, unit: BaseUnit): string {
  const listed = Array.isArray(product.data.measures) ? product.data.measures.find(item => item.unit === unit) : undefined;
  return listed ? listed.amount : product.data.quantity_unit === unit ? product.data.quantity_amount ?? "" : "";
}
export const microUnits = (value: number): bigint => BigInt(Math.round(value * 1000000));

export function combineQuantities(current: BasketQuantity | undefined, incoming: BasketQuantity): BasketQuantity | null {
  if (!current) return incoming;
  const left = baseQuantity(current), right = baseQuantity(incoming);
  if (left && right && left.unit === right.unit) {
    const sum = Math.round((left.amount + right.amount) * 1000000) / 1000000;
    if (sum > 999999) return null;
    return { amount: String(sum), unit: left.unit };
  }
  if (current.unit === "package" && incoming.unit === "package") {
    const sum = Math.round((Number(current.amount) + Number(incoming.amount)) * 1000000) / 1000000;
    return sum <= 999999 ? { amount: String(sum), unit: "package" } : null;
  }
  return null;
}

// Integer micro-units keep shared-pack ceilings exact at decimal boundaries.
const MICRO = 1000000n;
function decimalMicro(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  return match ? BigInt(match[1]) * MICRO + BigInt((match[2] ?? "").padEnd(6, "0")) : null;
}

export function purchaseDemand(item: BasketItem, product: BasketProduct, advanced: boolean) {
  const requested = advanced ? item.quantity : undefined;
  const size = decimalMicro(product.data.quantity_amount ?? "");
  if (!requested || requested.unit === "package") {
    const packages = requested ? decimalMicro(requested.amount) : MICRO;
    if (!packages) return null;
    return size
      ? { demand: packages * size, capacity: MICRO * size }
      : { demand: packages, capacity: MICRO };
  }
  const factor = factors[requested.unit];
  const amount = decimalMicro(requested.amount);
  const inUnit = factor ? decimalMicro(measureText(product, factor.unit)) : null;
  if (!factor || !amount || !inUnit) return null;
  return { demand: amount * BigInt(factor.factor) * MICRO, capacity: inUnit * MICRO };
}

export function pricedQuantity(item: BasketItem, product: BasketProduct, packageCents: number, advanced: boolean) {
  const requested = advanced ? item.quantity : undefined;
  if (!requested) return { packages: 1, cents: packageCents, usedCents: packageCents, used: false };
  if (requested.unit === "package") {
    const packages = Math.ceil(Number(requested.amount));
    return { packages, cents: packageCents * packages, usedCents: packageCents * Number(requested.amount), used: packages !== Number(requested.amount) };
  }
  const need = baseQuantity(requested);
  const amount = need ? productSizeIn(product, need.unit)?.amount : undefined;
  if (!need || amount === undefined) return null;
  const packages = Math.ceil(Math.round(need.amount * 1000000) / Math.round(amount * 1000000));
  if (!Number.isSafeInteger(packages) || packages <= 0 || packages > 999999) return null;
  return { packages, cents: packageCents * packages, usedCents: packageCents * need.amount / amount, used: true };
}
