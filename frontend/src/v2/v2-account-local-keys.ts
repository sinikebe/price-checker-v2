/**
 * Browser-storage keys that belong to one account (pure, so it can be unit-tested).
 *
 * Keys embed the numeric user id. A key must therefore be matched on the whole id: matching the
 * start of `v2:product:new:3` would also take `v2:product:new:30` and `v2:product:new:31:ean:...`,
 * which belong to other accounts that share the browser.
 */
export function accountLocalKeys(keys: readonly string[], userId: number, exactKeys: readonly string[] = []): string[] {
  const id = String(userId);
  const own = new Set([`v2:product:new:${id}`, `v2:recipe:new:${id}`, ...exactKeys]);
  const prefixes = [
    `v2:product:new:${id}:`, `v2:product:edit:${id}:`, `v2:product:draft:${id}:`,
    `v2:recipe:new:${id}:`, `v2:recipe:edit:${id}:`, `v2:recipe:proposal:${id}:`,
  ];
  return keys.filter(key => own.has(key)
    || prefixes.some(prefix => key.startsWith(prefix))
    || (key.startsWith("v2:basket:") && key.endsWith(":" + id)));
}
