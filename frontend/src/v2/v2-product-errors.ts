import { apiErrorText } from "./v2-http";

/**
 * The message to show for an error body of the product API: a plain `detail` text, or the French message of a
 * rule the server checks itself (a "value_error" of a validation, such as "one value per unit"). The built-in
 * validation messages are English and technical, so they stay the generic text.
 */
export function productErrorText(detail: unknown): string {
  return apiErrorText(detail, "L'opération a échoué.");
}
