import { validBasketQuantity, type BasketItem, type BasketQuantity } from "./v2-basket-storage";

export type SharedBasketEntry =
  | ["p", number, string, 0 | 1]
  | ["g", string, 0 | 1]
  | ["s", string, string, string, 0 | 1]
  | ["p", number, string, 0 | 1, BasketQuantity | null]
  | ["g", string, 0 | 1, BasketQuantity | null]
  | ["s", string, string, string, 0 | 1, BasketQuantity | null];

export const sharedEntryQuantity = (entry: SharedBasketEntry): BasketQuantity | undefined => {
  const value = entry[entry[0] === "p" ? 4 : entry[0] === "g" ? 3 : 5];
  return validBasketQuantity(value) ? value : undefined;
};
export const sharedEntryDisabled = (entry: SharedBasketEntry): boolean => Boolean(entry[entry[0] === "p" ? 3 : entry[0] === "g" ? 2 : 4]);

const MAX_ITEMS = 100;
const MAX_TOKEN_LENGTH = 12000;
const validText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 200;
const validFlag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;

export function encodeBasketShare(items: BasketItem[]): string | null {
  if (!items.length || items.length > MAX_ITEMS) return null;
  const entries: SharedBasketEntry[] = [];
  const version = items.some(item => item.quantity) ? 2 : 1;
  for (const item of items) {
    const disabled = item.disabled ? 1 : 0;
    if ("kind" in item) {
      if (!validText(item.name)) return null;
      if (item.kind === "group") entries.push(version === 2 ? ["g", item.name, disabled, item.quantity ?? null] : ["g", item.name, disabled]);
      else if (validText(item.department) && validText(item.family))
        entries.push(version === 2 ? ["s", item.department, item.family, item.name, disabled, item.quantity ?? null] : ["s", item.department, item.family, item.name, disabled]);
      else return null;
    } else {
      const label = [item.data.brand, item.data.name].filter(Boolean).join(" ").slice(0, 200);
      if (!Number.isSafeInteger(item.id) || item.id <= 0 || !validText(label)) return null;
      entries.push(version === 2 ? ["p", item.id, label, disabled, item.quantity ?? null] : ["p", item.id, label, disabled]);
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify([version, entries]));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const token = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return token.length <= MAX_TOKEN_LENGTH ? "#panier=" + token : null;
}

export function decodeBasketShare(hash: string): SharedBasketEntry[] | null {
  if (!hash.startsWith("#panier=")) return null;
  const token = hash.slice(8);
  if (!token || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const binary = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!Array.isArray(data) || (data[0] !== 1 && data[0] !== 2) || !Array.isArray(data[1])
      || data[1].length === 0 || data[1].length > MAX_ITEMS) return null;
    const entries: SharedBasketEntry[] = [];
    const version = data[0];
    const keys = new Set<string>();
    for (const entry of data[1]) {
      if (!Array.isArray(entry)) return null;
      let key: string;
      const quantityIndex = entry[0] === "p" ? 4 : entry[0] === "g" ? 3 : 5;
      const oldLength = quantityIndex;
      if (entry.length !== oldLength + (version === 2 ? 1 : 0)
        || (version === 2 && entry[quantityIndex] !== null && !validBasketQuantity(entry[quantityIndex]))) return null;
      if (entry[0] === "p" && Number.isSafeInteger(entry[1])
        && entry[1] > 0 && validText(entry[2]) && validFlag(entry[3])) {
        key = "p:" + entry[1];
      } else if (entry[0] === "g" && validText(entry[1]) && validFlag(entry[2])) {
        key = "g:" + entry[1].toLocaleLowerCase("fr");
      } else if (entry[0] === "s" && validText(entry[1])
        && validText(entry[2]) && validText(entry[3]) && validFlag(entry[4])) {
        key = ["s", entry[1], entry[2], entry[3]].map(String).join(":").toLocaleLowerCase("fr");
      } else return null;
      if (keys.has(key)) return null;
      keys.add(key);
      entries.push(entry as SharedBasketEntry);
    }
    return entries;
  } catch { return null; }
}

export function sharedEntryName(entry: SharedBasketEntry): string {
  return entry[0] === "p" ? entry[2] : entry[0] === "g" ? entry[1] : entry[3];
}
