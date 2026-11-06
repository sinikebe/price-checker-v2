/** The longest search the server accepts for duplicate candidates (moderation duplicate-candidates, q). */
export const DUPLICATE_QUERY_MAX_LENGTH = 100;

/**
 * The first candidate search of a duplicate review: the reported sheet's name (a store without one:
 * its city), cut to what the server accepts. A product name may be longer (160 characters), and a
 * value set from code is not cut by the field's maxLength. JavaScript counts UTF-16 units, never
 * fewer than the server's characters, so the cut text always fits; a character is never cut in
 * half, which would make the text impossible to put in the address.
 */
export function originQuery(data: Record<string, unknown>): string {
  const text = String(data.name ?? data.city ?? "").slice(0, DUPLICATE_QUERY_MAX_LENGTH);
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
}
