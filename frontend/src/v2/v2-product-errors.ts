const GENERIC = "L'opération a échoué.";

/**
 * The message to show for an error body of the product API: a plain `detail` text, or the French message of a
 * rule the server checks itself (a "value_error" of a validation, such as "one value per unit"). The built-in
 * validation messages are English and technical, so they stay the generic text.
 */
export function productErrorText(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    for (const item of detail as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const { type, msg } = item as { type?: unknown; msg?: unknown };
      if (type === "value_error" && typeof msg === "string") return msg.replace(/^Value error, /, "").slice(0, 300) || GENERIC;
    }
  }
  return GENERIC;
}
