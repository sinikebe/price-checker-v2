import type { BasketQuantity, BasketItem, BasketProduct } from "./v2-basket-storage";

type BaseUnit = "g" | "ml" | "piece";
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

export function combineQuantities(current: BasketQuantity | undefined, incoming: BasketQuantity): BasketQuantity | null {
  if (!current) return incoming;
  const left = baseQuantity(current), right = baseQuantity(incoming);
  if (left && right && left.unit === right.unit) {
    const sum = Math.round((left.amount + right.amount) * 1000000) / 1000000;
    if (sum > 999999) return null;
    return { amount: String(sum), unit: left.unit };
  }
  if (current.unit === "package" && incoming.unit === "package") {
    const sum = Number(current.amount) + Number(incoming.amount);
    return sum <= 999999 ? { amount: String(sum), unit: "package" } : null;
  }
  return null;
}

export function pricedQuantity(item: BasketItem, product: BasketProduct, packageCents: number, advanced: boolean) {
  const requested = advanced ? item.quantity : undefined;
  if (!requested) return { packages: 1, cents: packageCents, usedCents: packageCents, used: false };
  if (requested.unit === "package") {
    const packages = Math.ceil(Number(requested.amount));
    return { packages, cents: packageCents * packages, usedCents: packageCents * packages, used: false };
  }
  const need = baseQuantity(requested);
  const amount = Number(product.data.quantity_amount);
  if (!need || !Number.isFinite(amount) || amount <= 0 || need.unit !== product.data.quantity_unit) return null;
  const packages = Math.ceil(Math.round(need.amount * 1000000) / Math.round(amount * 1000000));
  if (!Number.isSafeInteger(packages) || packages <= 0 || packages > 999999) return null;
  return { packages, cents: packageCents * packages, usedCents: packageCents * need.amount / amount, used: true };
}
