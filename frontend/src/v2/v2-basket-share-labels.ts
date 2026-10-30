import type { BasketItem, BasketQuantity } from "./v2-basket-storage";

export function basketQuantityLabel(quantity?: BasketQuantity): string {
  if (!quantity) return "1 paquet";
  const unit = quantity.unit === "package" ? "paquet(s)" : quantity.unit === "piece" ? "pièce(s)" : quantity.unit;
  return `${quantity.amount} ${unit}`;
}

export function basketShareList(items: BasketItem[], url: string | null): string {
  const lines = items.map(item => {
    const name = "kind" in item ? item.name : [item.data.brand, item.data.name].filter(Boolean).join(" ");
    return `• ${name} — ${basketQuantityLabel(item.quantity)}${item.disabled ? " (exclu du calcul)" : ""}`;
  });
  return ["Mon panier Price Checker", ...lines, ...(url ? ["", "Ouvrir ce panier :", url] : [])].join("\n");
}
