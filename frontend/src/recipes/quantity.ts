// Recipe values have at most three fractional digits. Work with integers to
// avoid accumulating binary floating-point error; round only for the preview.
export function positiveDecimal(value: string): boolean {
  return /^\d+(?:\.\d{1,3})?$/.test(value) && /[1-9]/.test(value);
}
function thousandths(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"));
}
/** `amount` × `desired` / `base` in millionths, rounded half up; null unless all three are valid. */
function scaled(amount: string, desired: string, base: string): { rounded: bigint; exact: boolean } | null {
  if (![amount, desired, base].every(positiveDecimal)) return null;
  const numerator = thousandths(amount) * thousandths(desired) * 1000n;
  const denominator = thousandths(base);
  return { rounded: (numerator + denominator / 2n) / denominator, exact: numerator % denominator === 0n };
}
/** Whole part and fractional digits (trailing zeros dropped) of a value in millionths. */
function millionthsParts(value: bigint): { whole: string; fraction: string } {
  const digits = value.toString().padStart(7, "0");
  return { whole: digits.slice(0, -6), fraction: digits.slice(-6).replace(/0+$/, "") };
}
/** The scaled quantity for reading: "≈ 0,333333", "2", "1,5", or "—" when a value is invalid. */
export function scaledQuantity(amount: string, desired: string, base: string): string {
  const result = scaled(amount, desired, base);
  if (!result) return "—";
  const { whole, fraction } = millionthsParts(result.rounded);
  return `${result.exact ? "" : "≈ "}${whole}${fraction ? `,${fraction}` : ""}`;
}
/** The same quantity as a plain decimal for the basket: "0.333333", "2", "1.5", "0"; null when invalid. */
export function scaledAmount(amount: string, desired: string, base: string): string | null {
  const result = scaled(amount, desired, base);
  if (!result) return null;
  const { whole, fraction } = millionthsParts(result.rounded);
  return fraction ? `${whole}.${fraction}` : whole;
}
/** A stored decimal without its padding zeros, as typed in a field: "2.000" → "2", "1.500" → "1.5". */
export function plainDecimal(value: string): string {
  return /^\d+\.\d+$/.test(value) ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}
/** The same, written the French way for reading: "1.500" → "1,5". */
export function decimalText(value: string): string {
  return plainDecimal(value).replace(".", ",");
}
