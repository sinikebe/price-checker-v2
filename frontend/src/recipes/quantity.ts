// Recipe values have at most three fractional digits. Work with integers to
// avoid accumulating binary floating-point error; round only for the preview.
export function positiveDecimal(value: string): boolean {
  return /^\d+(?:\.\d{1,3})?$/.test(value) && /[1-9]/.test(value);
}
function thousandths(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"));
}
export function scaledQuantity(amount: string, desired: string, base: string): string {
  if (![amount, desired, base].every(positiveDecimal)) return "—";
  const numerator = thousandths(amount) * thousandths(desired) * 1000n;
  const denominator = thousandths(base);
  const rounded = (numerator + denominator / 2n) / denominator;
  const digits = rounded.toString().padStart(7, "0");
  const whole = digits.slice(0, -6);
  const fraction = digits.slice(-6).replace(/0+$/, "");
  const approximate = numerator % denominator !== 0n;
  return `${approximate ? "≈ " : ""}${whole}${fraction ? `,${fraction}` : ""}`;
}
